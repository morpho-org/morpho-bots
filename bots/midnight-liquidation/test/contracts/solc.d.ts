// solc ships no type declarations; declare the tiny standard-JSON surface the contract tests use.
declare module 'solc' {
  const solc: { compile: (input: string) => string }
  export default solc
}
