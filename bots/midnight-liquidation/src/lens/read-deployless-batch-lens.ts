import type { Id } from '@repo/utils'

// Vendored from prime-monorepo `packages/resolvers/src/rpc/read-deployless-batch-lens.ts`. Wraps
// viem-dlc's `policy()` + `readContract` so a single-array-in / single-array-out lens function is
// read deploylessly and chunked by viem-dlc. Copied (not depended on) per the TIB; promote to a
// shared package if a second bot needs it.
import { omit, policy } from '@morpho-org/viem-dlc'
import {
  type Abi,
  type AbiFunction,
  type CallParameters,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionParameters,
  type ContractFunctionReturnType,
  getAbiItem,
  type GetAbiItemParameters,
  type Transport
} from 'viem'
import { readContract } from 'viem/actions'
import { formatAbiItem } from 'viem/utils'

export const MAX_INITCODE_SIZE = 49_152

export type BatchLensTransportParameters = {
  'viem-dlc-cache': {
    ttl?: number
    delta?: number
  }
  'viem-dlc-deployless': {
    ttl?: undefined
    delta?: undefined
  }
}

export type BatchLensTransportType = Id<keyof BatchLensTransportParameters>

// (Upstream exports a `BatchLensClientParameters` helper here for callers that surface ttl/delta;
// our fetcher doesn't, so it's omitted to keep the dead-code gate happy.)

type Batch = NonNullable<Parameters<typeof policy>[0]['batch']>
type BatchGas = NonNullable<Batch['gas']>
type BatchGasConfig = { default?: BatchGas; overrides?: Record<number, BatchGas> }

type BatchLensFunctionMutability = 'pure' | 'view'

/**
 * Like `ContractFunctionArgs`, but constrained to be a single array of the same type because
 * we are essentially doing a map operation in the deployless contract.
 */
type BatchLensFunctionArgs<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, BatchLensFunctionMutability>,
  inputElement
> =
  readonly [readonly inputElement[]] extends ContractFunctionArgs<
    abi,
    BatchLensFunctionMutability,
    functionName
  >
    ? readonly [readonly inputElement[]]
    : never

/** `I` if the specified function matches (input: I[]) => O[], otherwise `never`. */
type BatchLensFunctionArgsInputElement<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, BatchLensFunctionMutability>
> =
  ContractFunctionArgs<abi, BatchLensFunctionMutability, functionName> extends readonly [infer Arg0]
    ? Arg0 extends readonly (infer Element)[]
      ? Element
      : never
    : never

/** Like `ContractFunctionReturnType`, but constrained to be a single array. */
type BatchLensFunctionReturnType<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, BatchLensFunctionMutability>,
  inputElement
> =
  ContractFunctionReturnType<
    abi,
    BatchLensFunctionMutability,
    functionName,
    BatchLensFunctionArgs<abi, functionName, inputElement>
  > extends readonly (infer Element)[]
    ? readonly Element[]
    : never

/** Like `ReadContractParameters`, but tailored to batch lenses. */
type ReadDeploylessBatchLensParameters<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, BatchLensFunctionMutability>,
  inputElement,
  transportType extends BatchLensTransportType = BatchLensTransportType
> = Omit<
  ContractFunctionParameters<
    abi,
    BatchLensFunctionMutability,
    functionName,
    BatchLensFunctionArgs<abi, functionName, inputElement>
  >,
  'args'
> &
  Pick<CallParameters, 'blockNumber' | 'blockOverrides' | 'blockTag'> &
  Required<Pick<CallParameters, 'factory' | 'factoryData'>> & {
    args: BatchLensFunctionArgs<abi, functionName, inputElement>
    batch?: Omit<Batch, 'gas'> & { gas?: BatchGasConfig }
  } & BatchLensTransportParameters[transportType]

export async function readDeploylessBatchLens<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, BatchLensFunctionMutability>,
  // NOTE: This constraint on `I` just provides editor hints when filling in `args`.
  // Without it, everything works except that `args` would be typed as `never` until properly filled in.
  I extends BatchLensFunctionArgsInputElement<abi, functionName>,
  K,
  V,
  transportType extends BatchLensTransportType = BatchLensTransportType
>(
  client: Client<Transport<transportType>>,
  parameters: ReadDeploylessBatchLensParameters<abi, functionName, I, transportType>,
  key: (input: I) => K,
  value: (input: I, output: BatchLensFunctionReturnType<abi, functionName, I>[number]) => V
): Promise<Map<K, V>> {
  const abiItem = getAbiItem({
    abi: parameters.abi,
    name: parameters.functionName,
    args: parameters.args
  } as GetAbiItemParameters) as AbiFunction
  const humanReadableAbiItem = formatAbiItem(abiItem)

  if (abiItem.inputs.length !== 1) {
    throw new Error(
      `readBatchLens requires function that takes a single array arg, got ${humanReadableAbiItem}.`
    )
  }
  if (abiItem.outputs.length !== 1) {
    throw new Error(
      `readBatchLens requires function that returns a single array, got ${humanReadableAbiItem}.`
    )
  }

  const { ttl, delta, batch, args, ...rest } = parameters

  if (args[0].length === 0) return new Map()

  const gas = resolveBatchGas(batch?.gas, client.chain?.id)
  const _batch = { ...omit(batch ?? {}, ['gas']), gas }

  if (process.env.MAX_DEPLOYLESS_BATCH_SIZE) {
    const maxBatchSize = Number.parseInt(process.env.MAX_DEPLOYLESS_BATCH_SIZE)
    if (Number.isFinite(maxBatchSize)) {
      _batch.batchSize =
        _batch.batchSize === undefined ? maxBatchSize : Math.min(_batch.batchSize, maxBatchSize)
    }
  }

  const outputs = await readContract(client, {
    ...rest,
    args,
    stateOverride: [
      policy({
        cache:
          ttl !== undefined
            ? {
                blobKey: `${rest.address}.${humanReadableAbiItem}`,
                ttl,
                delta
              }
            : undefined,
        batch: _batch,
        abi: abiItem
      })
    ]
  })

  if (!Array.isArray(outputs) || outputs.length !== args[0].length) {
    throw new Error(
      `readBatchLens received malformed output from ${rest.address}.${humanReadableAbiItem}`
    )
  }

  return new Map(args[0].map((input, i) => [key(input), value(input, outputs[i])]))
}

function resolveBatchGas(
  gas: BatchGasConfig | undefined,
  chainId: number | undefined
): BatchGas | undefined {
  if (gas === undefined) return undefined
  if (chainId !== undefined && gas.overrides?.[chainId]) return gas.overrides[chainId]
  return gas.default
}
