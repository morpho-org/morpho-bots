import type { Rule } from './rule.ts'

/** Spelling and capitalization from the Morpho content style guide's linter rules (v1.7). */
const COPY_RULES = [
  { id: 'spell-onchain', pattern: /\bon-chain\b|\bon chain\b(?!\s*(?:\d|$))/i, fix: 'onchain' },
  { id: 'spell-offchain', pattern: /\boff[- ]chain\b/i, fix: 'offchain' },
  { id: 'spell-defi', pattern: /\b(?:Defi|defi|DEFI)\b/, fix: 'DeFi' },
  { id: 'spell-erc4626', pattern: /\b(?:ERC4626|erc-?4626)\b/, fix: 'ERC-4626' },
  { id: 'spell-stablecoin', pattern: /\bstable[- ]coin/i, fix: 'stablecoin' },
  { id: 'spell-multisig', pattern: /\bmulti-sig\b/i, fix: 'multisig' },
  { id: 'spell-rebalance', pattern: /\bre-balanc/i, fix: 'rebalance' },
  { id: 'spell-apy-caps', pattern: /\b(?:apy|apr|Apy|Apr)\b/, fix: 'APY / APR' },
  { id: 'case-health-factor', pattern: /\bHealth Factor\b/, fix: 'health factor' },
  { id: 'case-morpho-protocols', pattern: /\bMorpho Protocol\b/, fix: 'Morpho protocols' },
  {
    id: 'case-vault-version',
    pattern: /\bVaults? v[12]\b|\bvaults? [vV][12]\b|\bVaults? [12]\b/,
    fix: 'Vault V1 / Vault V2'
  },
  {
    id: 'case-morpho-product',
    pattern:
      /\bmorpho (?:blue|midnight)\b|\bMorpho (?:blue|midnight)\b|\bmorpho (?:Blue|Midnight)\b/,
    fix: 'Morpho Blue / Morpho Midnight'
  },
  {
    id: 'case-morpho-term',
    pattern:
      /\b(?:Morpho|Blue|Midnight|V1|V2)\s+(?:market|vault|curator|allocator|sentinel|guardian|owner|gate)s?\b/,
    fix: 'the capitalized term: Market, Vault, Curator, Allocator, Sentinel, Guardian, Owner, Gate'
  },
  { id: 'term-offer-book', pattern: /\border[- ]?books?\b/i, fix: 'offer book' },
  { id: 'term-metamorpho', pattern: /\bMetaMorpho\b/, fix: 'Morpho Vault V1' },
  {
    id: 'inclusive-language',
    pattern: /\bsanity[- ]check|\bblind[- ]?spots?\b/i,
    fix: 'check / gap'
  }
] as const

const CODE_SPAN = /`[^`]*`|\{@link[^}]*\}|https?:\/\/\S+|'[^'\s]+'/g

export const copyIssues = (text: string) => {
  const prose = text.replace(CODE_SPAN, ' ')
  return COPY_RULES.filter(({ pattern }) => pattern.test(prose)).map(
    ({ id, fix }) => `${id}: use ${fix}`
  )
}

const hasWhitespace = (text: string) => /\s/.test(text)

type Visitor = ReturnType<Rule['create']>
type Tag = Parameters<NonNullable<Visitor['TaggedTemplateExpression']>>[0]['tag']

const isSolTag = (tag: Tag): boolean =>
  tag.type === 'Identifier'
    ? tag.name === 'sol'
    : tag.type === 'CallExpression' && tag.callee.type !== 'Super' && isSolTag(tag.callee)

export const copyStyle: Rule = {
  create: context => {
    let solDepth = 0
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const message of copyIssues(comment.value))
            context.report({ loc: comment.loc, message })
        }
      },
      TaggedTemplateExpression(node) {
        if (isSolTag(node.tag)) solDepth++
      },
      'TaggedTemplateExpression:exit'(node) {
        if (isSolTag(node.tag)) solDepth--
      },
      Literal(node) {
        if (typeof node.value !== 'string' || !hasWhitespace(node.value)) return
        for (const message of copyIssues(node.value)) context.report({ node, message })
      },
      TemplateElement(node) {
        const text = node.value.cooked ?? ''
        if (solDepth > 0 || !hasWhitespace(text)) return
        for (const message of copyIssues(text)) context.report({ node, message })
      },
      JSXText(node) {
        for (const message of copyIssues(node.value)) context.report({ node, message })
      }
    }
  }
}
