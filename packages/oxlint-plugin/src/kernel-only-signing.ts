import type { Rule } from './rule.ts'

import { pathSegments } from './bot-path.ts'

const SIGNING_MODULES = [
  'viem/accounts',
  '@aws-sdk/client-kms',
  '@ethereumjs/wallet',
  '@noble/curves',
  '@noble/secp256k1'
]

/**
 * viem's and the repo's constructors and actions that sign, broadcast, or build a signer, and
 * `createRequire`, which would load a signing module unseen.
 */
const SIGNING_NAMES = new Set([
  'createWalletClient',
  'walletActions',
  'privateKeyToAccount',
  'mnemonicToAccount',
  'hdKeyToAccount',
  'toAccount',
  'sendRawTransaction',
  'sendRawTransactionSync',
  'sendTransaction',
  'sendTransactionSync',
  'sendCalls',
  'sendCallsSync',
  'sendUnsignedTransaction',
  'sendUserOperation',
  'signUserOperation',
  'writeContract',
  'writeContracts',
  'writeContractSync',
  'deployContract',
  'depositTransaction',
  'initiateWithdrawal',
  'proveWithdrawal',
  'finalizeWithdrawal',
  'signTransaction',
  'signTypedData',
  'signMessage',
  'signAuthorization',
  'createAccountSigner',
  'createKernelEffects',
  'createKeystoreAccount',
  'createKmsAccount',
  'createSigner',
  'transactionKernelSpec',
  'createRequire'
])

const SIGNING_RPC_METHOD = /^(eth_send|eth_sign|personal_sign|wallet_send)/

const MESSAGE =
  "A bot signs and broadcasts only through its kernel: keep this in the bot's `src/kernel.ts` (ADR-2026-09-30)"

const isSigningModule = (specifier: unknown) =>
  typeof specifier === 'string' &&
  SIGNING_MODULES.some(module => specifier === module || specifier.startsWith(`${module}/`))

const isSigningString = (value: unknown) =>
  typeof value === 'string' && (SIGNING_NAMES.has(value) || SIGNING_RPC_METHOD.test(value))

const onlyTypes = (
  kind: string | undefined,
  specifiers: readonly { importKind?: string; exportKind?: string }[]
) =>
  kind === 'type' ||
  (specifiers.length > 0 &&
    specifiers.every(({ importKind, exportKind }) => (importKind ?? exportKind) === 'type'))

const inBotSourceOutsideKernel = (filename: string, cwd: string) => {
  const [root, , directory, ...rest] = pathSegments(filename, cwd)
  if (root !== 'bots' || directory !== 'src') return false
  return !(rest.length === 1 && rest[0] === 'kernel.ts')
}

/**
 * Confines signing modules, signer constructors, broadcast actions, and signing RPC methods to
 * `bots/<bot>/src/kernel.ts`. It matches names, not bindings, so review still checks for a signer
 * reached some other way.
 */
export const kernelOnlySigning: Rule = {
  create: context => {
    if (!inBotSourceOutsideKernel(context.filename, context.cwd)) return {}
    const reported = new Set<number>()
    const report = (node: Parameters<typeof context.report>[0]['node'] & { start: number }) => {
      if (reported.has(node.start)) return
      reported.add(node.start)
      context.report({ node, message: MESSAGE })
    }
    return {
      ImportDeclaration(node) {
        if (
          !onlyTypes(node.importKind, node.specifiers as never) &&
          isSigningModule(node.source.value)
        )
          report(node)
      },
      ExportNamedDeclaration(node) {
        if (
          !onlyTypes(node.exportKind, node.specifiers as never) &&
          node.source &&
          isSigningModule(node.source.value)
        )
          report(node)
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && isSigningModule(node.source.value)) report(node)
      },
      ImportExpression(node) {
        const { source } = node
        if (source.type !== 'Literal' || isSigningModule(source.value)) report(node)
      },
      CallExpression(node) {
        const [argument] = node.arguments
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          (argument?.type !== 'Literal' || isSigningModule(argument.value))
        )
          report(node)
      },
      Identifier(node) {
        if (SIGNING_NAMES.has(node.name)) report(node)
      },
      Literal(node) {
        if (isSigningString(node.value)) report(node)
      },
      TemplateElement(node) {
        if (isSigningString(node.value.cooked)) report(node)
      }
    }
  }
}
