import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

export async function confirm(message: string) {
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    return (
      (await prompt.question(`${message} Type "yes" to continue: `)).trim().toLowerCase() === 'yes'
    )
  } finally {
    prompt.close()
  }
}
