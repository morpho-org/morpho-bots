import { commentHygiene } from './comment-hygiene.ts'
import { copyStyle } from './copy-style.ts'
import { errorsFile } from './errors-file.ts'
import { noAsAddress } from './no-as-address.ts'
import { noHexTemplate } from './no-hex-template.ts'
import { noLocalMathConstant } from './no-local-math-constant.ts'
import { noPow10Bigint } from './no-pow10-bigint.ts'
import { noReplayInSrc } from './no-replay-in-src.ts'
import { requireChecksumAddress } from './require-checksum-address.ts'
import { testUnderTestDir } from './test-under-test-dir.ts'
import { utilsApartFromClasses } from './utils-apart-from-classes.ts'

export default {
  meta: { name: 'repo' },
  rules: {
    'comment-hygiene': commentHygiene,
    'copy-style': copyStyle,
    'errors-file': errorsFile,
    'no-as-address': noAsAddress,
    'no-hex-template': noHexTemplate,
    'no-local-math-constant': noLocalMathConstant,
    'no-pow10-bigint': noPow10Bigint,
    'no-replay-in-src': noReplayInSrc,
    'require-checksum-address': requireChecksumAddress,
    'test-under-test-dir': testUnderTestDir,
    'utils-apart-from-classes': utilsApartFromClasses
  }
}
