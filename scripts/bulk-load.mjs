/**
 * bulk-load.mjs — Carga em lote de arquivos DFS (jan/24 → dez/25)
 *
 * Uso:
 *   node scripts/bulk-load.mjs "C:\caminho\para\pasta\com\DFS"
 *
 * O script detecta o período via:
 *   - Nome do arquivo (ex: "DFS 2025-01.xlsx" → 2025-01)
 *   - Fallback: pergunta no console
 *
 * Requer: @supabase/supabase-js e xlsx (já no package.json)
 */

import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'
import { createHash } from 'crypto'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'

// ── Ler .env.local ────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(process.cwd(), '.env.local')
  if (!existsSync(envPath)) throw new Error('.env.local não encontrado')
  const raw = readFileSync(envPath, 'utf-8')
  const env = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const ENV = loadEnv()
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = ENV.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY = ENV.ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('❌ Faltam variáveis: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// ── Config ────────────────────────────────────────────────────────────────────
const MODE  = process.argv[2]
const ARG   = process.argv[3]
const isBulkMode = MODE !== '--from-balancete'
const FOLDER = isBulkMode ? MODE : null

if (isBulkMode && (!FOLDER || !existsSync(FOLDER))) {
  console.error('❌ Uso:\n   node scripts/bulk-load.mjs "<pasta_xlsx>"\n   node scripts/bulk-load.mjs --from-balancete "<arquivo.xlsx>"')
  process.exit(1)
}
if (!isBulkMode && (!ARG || !existsSync(ARG))) {
  console.error('❌ Informe o caminho do arquivo xlsx:\n   node scripts/bulk-load.mjs --from-balancete "DFS 2025-01.xlsx"')
  process.exit(1)
}

const TABLE_PREFIX = 'dev_'  // mudar para '' em produção
const tbl = (t) => TABLE_PREFIX + t
const FORCE = process.argv.includes('--force')
const FROM_IDX = process.argv.indexOf('--from')
const FROM_PERIODO = FROM_IDX !== -1 ? process.argv[FROM_IDX + 1] : null

const ABAS_ALVO = ['BP', 'DRE', 'DFC', 'DMPL', 'DRA',
  '12.Receita Bruta', '13.Custos com futebol',
  '14.Despesas Operacionais', '15.Resultado Financeiro']
const BALANCETE_SHEET_NAMES = ['Balancete', 'balancete', 'BALANCETE', 'Balanc', '100.Balancete']
const MAX_CHARS = 40000

// ── Detectar período do nome do arquivo ───────────────────────────────────────
function detectPeriodo(filename) {
  // Padrão: "DFS 2025-01.xlsx" ou "DFS CBF 01_2025" ou "2025-01" etc.
  let m
  m = filename.match(/(\d{4})[_\-](\d{2})/)
  if (m) return `${m[1]}-${m[2]}`
  m = filename.match(/(\d{2})[_\-](\d{4})/)
  if (m) return `${m[2]}-${m[1]}`
  return null
}

// ── SheetJS helpers ────────────────────────────────────────────────────────────
function xlsxToText(workbook, prioritySheets) {
  const parts = []
  let totalChars = 0
  const ordered = []
  if (prioritySheets) {
    for (const prio of prioritySheets) {
      const lower = prio.toLowerCase()
      for (const name of workbook.SheetNames) {
        if (!ordered.includes(name) && (name === prio || name.toLowerCase() === lower)) ordered.push(name)
      }
    }
  }
  for (const name of workbook.SheetNames) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  for (const name of ordered) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', blankrows: false })
    if (!csv.trim()) continue
    const lines = csv.split('\n')
    const truncated = lines.length > 500 ? lines.slice(0, 500).join('\n') + '\n[... truncado]' : csv
    if (totalChars + truncated.length > MAX_CHARS) {
      parts.push(`### Aba: ${name}\n[Aba omitida - limite atingido]`)
      continue
    }
    parts.push(`### Aba: ${name}\n${truncated}`)
    totalChars += truncated.length
  }
  return parts.join('\n\n')
}

function balanceteToText(workbook, sheetName, periodo) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return ''
  const [ano, mes] = periodo.split('-')
  const month = parseInt(mes)
  const year = parseInt(ano)
  const lastDay = new Date(year, month, 0).getDate()
  const periodoBalancete = `${month}/${lastDay}/${String(year).slice(2)}`
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '|', blankrows: false })
  const lines = csv.split('\n')
  const headerLine = lines.find(l => l.includes('Período') || l.includes('Conta'))
  const filtradas = lines.filter(l => {
    const cols = l.split('|')
    return cols[1] === periodoBalancete && /\|S\|/.test(l)
  })
  if (filtradas.length === 0) return ''
  const header = headerLine ? headerLine + '\n' : ''
  return `### Aba: ${sheetName} (período ${periodoBalancete}, contas sintéticas)\n${header}${filtradas.join('\n')}`
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function deepMerge(existing, incoming, sourcePriority = 'incoming') {
  if (incoming === null || incoming === undefined) return existing
  if (existing === null || existing === undefined) return incoming
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    if (sourcePriority === 'incoming') return incoming !== null && incoming !== undefined ? incoming : existing
    if (existing !== null && existing !== undefined && existing !== 0) return existing
    return incoming !== null && incoming !== undefined && incoming !== 0 ? incoming : existing
  }
  const result = { ...existing }
  for (const [key, val] of Object.entries(incoming)) {
    if (key === '_sources') continue
    result[key] = deepMerge(existing[key], val, sourcePriority)
  }
  return result
}

// ── Extração direta pelo campo dfs do balancete ───────────────────────────────
// Mapeamento: valor da coluna dfs → campo do banco de dados
const DFS_TO_FIELD = {
  // Ativo Circulante
  'AC - Caixa e equivalentes de caixa':     'caixa_equivalentes',
  'AC - Contas a receber de clientes':      'contas_receber',
  'AC - Adiantamentos A Fornecedores':      'adiantamentos',
  'AC - Despesas Antecipadas':              'despesas_antecipadas',
  'AC - Tributos a recuperar':              'tributos_recuperar',
  // Ativo Não Circulante
  'ANC - Contas a Receber':                 'contas_receber_lp',
  'ANC - Depósitos Judiciais':              'depositos_judiciais',
  'ANC - Investimentos':                    'investimentos',
  'ANC - Imobilizado':                      'imobilizado',
  'ANC - Intangível':                       'intangivel',
  // Passivo Circulante (saldo normal credor = valor negativo no SF → negar)
  'PC - Fornecedores e contas a pagar':     'fornecedores',
  'PC - Obrigações sociais e trabalhistas': 'obrig_trabalhistas',
  'PC - Provisão para férias e encargos':   'provisao_ferias',
  'PC - Receitas diferidas':                'receitas_diferidas_cp',
  'PC - IR e CSLL a pagar':                 '_ir_csll_cp',  // incluído no passivo_circulante
  // Passivo Não Circulante (negar)
  'PNC - Receitas Diferidas':               'receitas_diferidas_lp',
  'PNC - Fornecedores LP':                  'fornecedores_lp',
  'PNC - Provisão para contingências':      'prov_contingencias',
  // Patrimônio Líquido (negar — inclui capital + lucros/prejuízos acumulados)
  'PL - Patrimônio Social':                 'patrimonio_social',
}
// Prefixos cujo VALOR SF é credor (negativo) → negar para obter valor positivo
const DFS_NEGATE = ['PC -', 'PNC -', 'PL -']

// Colunas fixas do balancete (verificadas empiricamente)
const BAL_COL = { PERIODO: 1, DFS: 13, VALOR_SF: 16, MOV_PERIODO: 8 }

// Converte "YYYY-MM" para serial Excel (último dia do mês)
function periodoToSerial(periodo) {
  const [ano, mes] = periodo.split('-').map(Number)
  const dtUltimoDia = new Date(ano, mes, 0) // último dia do mês
  const excelEpoch  = new Date(1899, 11, 30)
  return Math.round((dtUltimoDia - excelEpoch) / 86_400_000)
}

function extractBalanceteByDfs(workbook, sheetName, periodo) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return null

  const serial = periodoToSerial(periodo)
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  const hdrIdx = data.findIndex(r => r.some(c => String(c).includes('Período')))
  if (hdrIdx < 0) return null

  // Somar VALOR SF agrupado por campo
  const sums = {}
  for (const r of data.slice(hdrIdx + 1)) {
    if (r[BAL_COL.PERIODO] !== serial) continue
    const dfs = String(r[BAL_COL.DFS] || '').trim()
    const field = DFS_TO_FIELD[dfs]
    if (!field) continue
    const v = typeof r[BAL_COL.VALOR_SF] === 'number' ? r[BAL_COL.VALOR_SF] : 0
    sums[field] = (sums[field] || 0) + v
  }

  if (Object.keys(sums).length === 0) return null

  // ── Detecção automática de escala ────────────────────────────────────────────
  // Balancetes normalmente têm valores em R$ reais (ex: 159.161.291) → dividir por 1000.
  // Se max < 1.000.000, os valores já estão em R$ milhares → não dividir.
  const maxAbsSum = Math.max(...Object.values(sums).map(Math.abs))
  const balScale = maxAbsSum > 1_000_000 ? 1000 : 1
  if (balScale === 1) {
    console.log(`      ℹ️  Balancete — valores em R$ milhares detectados (max=${maxAbsSum.toFixed(0)}), sem ÷1000`)
  }

  // Aplicar sinal e converter para milhares (ou manter se já em milhares)
  const bal = {}
  for (const [field, sum] of Object.entries(sums)) {
    const dfsKey = Object.keys(DFS_TO_FIELD).find(k => DFS_TO_FIELD[k] === field)
    const negate = dfsKey && DFS_NEGATE.some(p => dfsKey.startsWith(p))
    bal[field] = parseFloat(((negate ? -sum : sum) / balScale).toFixed(3))
  }

  // Calcular campos totais derivados
  const acKeys  = ['caixa_equivalentes','contas_receber','adiantamentos','despesas_antecipadas','tributos_recuperar']
  const ancKeys = ['contas_receber_lp','depositos_judiciais','investimentos','imobilizado','intangivel']
  const pcKeys  = ['fornecedores','obrig_trabalhistas','provisao_ferias','receitas_diferidas_cp','_ir_csll_cp']
  const pncKeys = ['receitas_diferidas_lp','fornecedores_lp','prov_contingencias']
  const sum = (keys) => keys.reduce((s, k) => s + (bal[k] ?? 0), 0)

  bal.ativo_circulante   = parseFloat(sum(acKeys).toFixed(3))
  bal.ativo_total        = parseFloat((sum(acKeys) + sum(ancKeys)).toFixed(3))
  bal.passivo_circulante = parseFloat(sum(pcKeys).toFixed(3))
  bal.patrimonio_liquido = parseFloat((bal.patrimonio_social ?? 0).toFixed(3))

  // Remover campo interno temporário
  delete bal._ir_csll_cp

  return bal
}

// ── Extração direta da aba DRE ────────────────────────────────────────────────
const DRE_LABEL_MAP = {
  'DRE -  Patrocínio':                           'rec_patrocinio',
  'DRE - Direito de Transmissão':                'rec_transmissao',
  'DRE - Bilheteria e Premiações':               'rec_bilheteria',
  'DRE - Registros e Transferências':            'rec_registros',
  'DRE - Legado':                                'rec_legado',
  'DRE - Programa de desenvolvimento':           'rec_desenvolvimento',
  'DRE - CBF Academy':                           'rec_academy',
  'DRE - Deduções da Receita':                   '_deducoes',
  'DRE - Seleção Principal':                     'custo_selecao_principal',
  'DRE - Seleções de base e femininas':          'custo_selecao_base',
  'Seleções Femininas':                          'custo_selecao_femininas',
  'DRE - Contribuição ao Fomento do futebol':    'custo_fomento',
  'DRE - Pessoal':                               'desp_pessoal',
  'DRE - Administrativas':                       'desp_administrativas',
  'DRE - Impostos e taxas':                      'desp_impostos_taxas',
  'DRE - Receitas financeiras':                  'res_fin_receitas',
  'DRE - Despesas financeiras':                  'res_fin_despesas',
  'DRE - Variação Cambial':                      'res_fin_cambial',
  'DRE - Outras Receitas Operacionais':          '_outras_rec',
  'DRE - Outras Despesas Operacionais':          '_outras_desp',
  'DRE - Imposto de renda e contribuição social':'_ir_csll',
}

function extractDREFromSheet(workbook, periodo) {
  const sheetName = workbook.SheetNames.find(n => n.toUpperCase() === 'DRE')
  if (!sheetName) return null
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return null

  const serial = periodoToSerial(periodo)
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })

  // Descobrir coluna do período alvo
  let valCol = -1
  for (const r of data) {
    const i = r.indexOf(serial)
    if (i >= 0) { valCol = i; break }
  }
  if (valCol < 0) return null  // período não existe nesta aba

  // Ler valores por label — col[0] tem o prefixo "DRE -"; Seleções Femininas usa col[0]='' e col[1] como label
  // Nota: quando a célula da esquerda é mesclada, r[0] fica '' e o texto vai para r[1]
  const raw = {}
  for (const r of data) {
    const label = (String(r[0] || '').trim() || String(r[1] || '').trim())
    const field = DRE_LABEL_MAP[label]
    if (!field) continue
    const val = r[valCol]
    if (typeof val === 'number') raw[field] = val
  }

  // ── Detecção automática de escala ────────────────────────────────────────────
  // Se os maiores valores superam 1.000.000 os dados estão em R$ reais → dividir por 1000.
  // Se estão abaixo disso, já estão em R$ milhares → manter como estão.
  // Isso garante que arquivos futuros com escalas diferentes sejam tratados corretamente.
  const maxAbsVal = Math.max(...Object.values(raw).map(Math.abs))
  const scale = maxAbsVal > 1_000_000 ? 1000 : 1
  if (scale === 1000) {
    console.log(`      ℹ️  DRE — valores em R$ reais detectados (max=${maxAbsVal.toFixed(0)}), aplicando ÷1000`)
  }

  const g = (k) => raw[k] != null ? parseFloat((raw[k] / scale).toFixed(3)) : null

  // Itens de receita (positivos na DRE = crédito)
  const rec_patrocinio    = g('rec_patrocinio')
  const rec_transmissao   = g('rec_transmissao')
  const rec_bilheteria    = g('rec_bilheteria')
  const rec_registros     = g('rec_registros')
  const rec_desenvolvimento = g('rec_desenvolvimento')
  const rec_academy       = g('rec_academy')
  const deducoes          = g('_deducoes')
  const custo_principal   = g('custo_selecao_principal')
  const custo_base        = g('custo_selecao_base')
  const custo_femininas   = g('custo_selecao_femininas')
  const custo_fomento     = g('custo_fomento')
  const desp_pessoal      = g('desp_pessoal')
  const desp_admin        = g('desp_administrativas')
  const desp_impostos     = g('desp_impostos_taxas')
  const res_fin_rec       = g('res_fin_receitas')
  const res_fin_desp      = g('res_fin_despesas')
  const res_fin_camb      = g('res_fin_cambial')
  const outras_rec        = g('_outras_rec')
  const outras_desp       = g('_outras_desp')
  const ir_csll           = g('_ir_csll')

  const s = (...args) => parseFloat(args.reduce((acc, v) => acc + (v ?? 0), 0).toFixed(3))

  const receita_bruta        = s(rec_patrocinio, rec_transmissao, rec_bilheteria, rec_registros, rec_desenvolvimento, rec_academy)
  const receita_liquida      = s(receita_bruta, deducoes)
  const custos_futebol       = s(custo_principal, custo_base, custo_femininas, custo_fomento)
  const superavit_bruto      = s(receita_liquida, custos_futebol)
  const despesas_operacionais = s(desp_pessoal, desp_admin, desp_impostos)
  const resultado_financeiro = s(res_fin_rec, res_fin_desp, res_fin_camb)
  const resultado_exercicio  = s(superavit_bruto, despesas_operacionais, resultado_financeiro, outras_rec, outras_desp, ir_csll)

  return {
    receita_bruta, receita_liquida, custos_futebol, superavit_bruto,
    despesas_operacionais, resultado_financeiro, resultado_exercicio,
    rec_patrocinio, rec_transmissao, rec_bilheteria, rec_registros,
    rec_desenvolvimento, rec_academy,
    rec_financeiras: res_fin_rec,
    custo_selecao_principal: custo_principal,
    custo_selecao_base: custo_base,
    custo_selecao_femininas: custo_femininas,
    custo_fomento,
    desp_pessoal, desp_administrativas: desp_admin, desp_impostos_taxas: desp_impostos,
    res_fin_receitas: res_fin_rec, res_fin_despesas: res_fin_desp, res_fin_cambial: res_fin_camb,
    resultado_acumulado: resultado_exercicio,  // YTD = resultado do exercício
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────────
function buildPrompt(periodo, filename) {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados do arquivo xlsx das DFs da CBF (arquivo: ${filename}, período: ${periodo}).
Extraia TODOS os dados numéricos das abas: BP, DRE, DFC, e Notas 12, 13, 14 e 15.
Valores em R$ milhares. Use SEMPRE a primeira coluna numérica (período ${dataRef}).

Retorne APENAS um JSON válido:
\`\`\`json
{
  "periodo": "${periodo}", "fonte": "${filename}",
  "dre": { "receita_bruta": 0, "deducoes": 0, "receita_liquida": 0, "custos_futebol": 0,
    "superavit_bruto": 0, "despesas_operacionais": 0, "resultado_financeiro": 0,
    "outras_receitas": 0, "outras_despesas": 0, "resultado_antes_ir": 0, "ir_csll": 0, "resultado_exercicio": 0 },
  "receitas": { "patrocinio": 0, "transmissao": 0, "bilheteria": 0, "registros": 0, "desenvolvimento": 0, "academy": 0, "legado": 0 },
  "custos_futebol": { "selecao_principal": 0, "selecoes_base": 0, "selecoes_femininas": 0, "fomento": 0 },
  "despesas": { "pessoal": 0, "administrativas": 0, "impostos_taxas": 0 },
  "resultado_financeiro": { "receitas_financeiras": 0, "despesas_financeiras": 0, "variacao_cambial": 0, "total": 0 },
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0, "contas_receber_lp": 0,
    "depositos_judiciais": 0, "investimentos": 0, "imobilizado": 0, "intangivel": 0,
    "passivo_circulante": 0, "fornecedores": 0, "programas_desenvolvimento": 0, "obrig_trabalhistas": 0,
    "provisao_ferias": 0, "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0, "patrimonio_liquido": 0 },
  "dfc": { "fluxo_operacional": 0, "fluxo_investimento": 0, "variacao_total": 0, "saldo_inicial": 0, "saldo_final": 0 }
}
\`\`\`
Use os valores exatos. Se não existir, use null.`
}

function buildHybridPrompt(periodo, filename, balanceteSheetName) {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é especialista em demonstrações financeiras brasileiras.
Analise os dados do arquivo xlsx das DFs da CBF (arquivo: ${filename}, período: ${periodo}).
Este arquivo contém DFs (BP, DRE, DFC, Notas) E aba de Balancete ("${balanceteSheetName}").

### DFs: use primeira coluna numérica (${dataRef}). Valores em R$ milhares.
### Balancete: complementa e valida os totais das DFs.
### Prioridade: para campos consolidados use as DFs; balancete só para detalhamento.

Retorne APENAS um JSON válido:
\`\`\`json
{
  "periodo": "${periodo}", "fonte": "${filename}",
  "dre": { "receita_bruta": 0, "deducoes": 0, "receita_liquida": 0, "custos_futebol": 0,
    "superavit_bruto": 0, "despesas_operacionais": 0, "resultado_financeiro": 0,
    "outras_receitas": 0, "outras_despesas": 0, "resultado_antes_ir": 0, "ir_csll": 0, "resultado_exercicio": 0 },
  "receitas": { "patrocinio": 0, "transmissao": 0, "bilheteria": 0, "registros": 0, "desenvolvimento": 0, "academy": 0, "legado": 0 },
  "custos_futebol": { "selecao_principal": 0, "selecoes_base": 0, "selecoes_femininas": 0, "fomento": 0 },
  "despesas": { "pessoal": 0, "administrativas": 0, "impostos_taxas": 0 },
  "resultado_financeiro": { "receitas_financeiras": 0, "despesas_financeiras": 0, "variacao_cambial": 0, "total": 0 },
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0, "contas_receber_lp": 0,
    "depositos_judiciais": 0, "investimentos": 0, "imobilizado": 0, "intangivel": 0,
    "passivo_circulante": 0, "fornecedores": 0, "programas_desenvolvimento": 0, "obrig_trabalhistas": 0,
    "provisao_ferias": 0, "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0, "patrimonio_liquido": 0 },
  "dfc": { "fluxo_operacional": 0, "fluxo_investimento": 0, "variacao_total": 0, "saldo_inicial": 0, "saldo_final": 0 }
}
\`\`\`
Use os valores exatos. Se não existir, use null.`
}

// ── Extrair períodos únicos do balancete (col[1] = "M/DD/YY") ───────────────────
function getAllBalancetePeriods(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return []
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '|', blankrows: false })
  const seen = new Set()
  for (const line of csv.split('\n')) {
    const col1 = line.split('|')[1]?.trim()
    if (col1 && /^\d+\/\d+\/\d+$/.test(col1)) seen.add(col1)
  }
  return [...seen]
}

// "M/DD/YY" → "YYYY-MM"
function periodStringToYearMonth(str) {
  const [m, , yy] = str.split('/')
  if (!m || !yy) return null
  const year = 2000 + parseInt(yy)
  return `${year}-${String(parseInt(m)).padStart(2, '0')}`
}

// ── Prompt somente balancete ───────────────────────────────────────────────────
function buildBalanceteOnlyPrompt(periodo) {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é especialista em demonstrações financeiras brasileiras.
Analise o balancete contábil da CBF para o período ${dataRef}.
Os dados são contas sintéticas. Use a coluna VALOR SF (Saldo Final) ou Saldo Atual.
Valores em reais (não converter para milhares).

Retorne APENAS um JSON válido:
\`\`\`json
{
  "periodo": "${periodo}",
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0, "contas_receber_lp": 0,
    "depositos_judiciais": 0, "investimentos": 0, "imobilizado": 0, "intangivel": 0,
    "passivo_circulante": 0, "fornecedores": 0, "programas_desenvolvimento": 0, "obrig_trabalhistas": 0,
    "provisao_ferias": 0, "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0, "patrimonio_liquido": 0
  }
}
\`\`\`
Se não existir, use null.`
}

// ── Processar um período do balancete ─────────────────────────────────────────
async function processBalancetePeriodo(workbook, balanceteSheetName, periodo, filename) {
  const balanceteText = balanceteToText(workbook, balanceteSheetName, periodo)
  if (!balanceteText || balanceteText.length < 100) {
    console.log(`   ⚠️  Sem dados de balancete para ${periodo} — pulando`)
    return { ok: false, periodo, reason: 'sem dados' }
  }
  const balanceteHash = hashText(balanceteText)

  const { data: existingRow } = await supabase
    .from(tbl('dados_financeiros'))
    .select('dados_raw, ativo_total, ativo_circulante, caixa_equivalentes, contas_receber, tributos_recuperar, depositos_judiciais, imobilizado, passivo_circulante, receitas_diferidas_cp, receitas_diferidas_lp, prov_contingencias, patrimonio_liquido, patrimonio_social, fornecedores, obrig_trabalhistas, adiantamentos, intangivel, resultado_acumulado, despesas_antecipadas, contas_receber_lp, investimentos, programas_desenvolvimento, provisao_ferias, fornecedores_lp')
    .eq('periodo', periodo)
    .maybeSingle()

  const storedHash = existingRow?.dados_raw?._balancete_hash ?? null
  if (!FORCE && storedHash && storedHash === balanceteHash) {
    console.log(`   ⏭️  ${periodo} — balancete inalterado, pulando`)
    return { ok: true, periodo, skipped: true }
  }

  console.log(`   🔄 ${periodo} — ${balanceteText.split('\n').length} linhas | hash ${balanceteHash}`)

  // Extração direta pelo campo dfs (sem Claude — determinístico)
  const balanco = extractBalanceteByDfs(workbook, balanceteSheetName, periodo)
  if (!balanco || Object.keys(balanco).length === 0) {
    throw new Error(`Não foi possível extrair dados pelo campo dfs para ${periodo}`)
  }

  const existingRaw = existingRow?.dados_raw || {}
  // Com --force, não usa fallback do existingRow para campos do balancete (evita dados stale)
  const pick = (inc, ex) => (inc !== null && inc !== undefined) ? inc : (FORCE ? null : ex)
  const keep = (v) => v ?? null  // preserva existente se não extraído

  // Extração DRE direta da aba DRE (só funciona para períodos presentes na aba)
  const dre = extractDREFromSheet(workbook, periodo)
  const pickDRE = (dreVal, existingVal) => dreVal != null ? dreVal : keep(existingVal)

  const row = {
    periodo,
    // BP — balancete via dfs
    ativo_total:               pick(balanco.ativo_total,               existingRow?.ativo_total),
    ativo_circulante:          pick(balanco.ativo_circulante,          existingRow?.ativo_circulante),
    caixa_equivalentes:        pick(balanco.caixa_equivalentes,        existingRow?.caixa_equivalentes),
    contas_receber:            pick(balanco.contas_receber,            existingRow?.contas_receber),
    tributos_recuperar:        pick(balanco.tributos_recuperar,        existingRow?.tributos_recuperar),
    depositos_judiciais:       pick(balanco.depositos_judiciais,       existingRow?.depositos_judiciais),
    imobilizado:               pick(balanco.imobilizado,               existingRow?.imobilizado),
    passivo_circulante:        pick(balanco.passivo_circulante,        existingRow?.passivo_circulante),
    receitas_diferidas_cp:     pick(balanco.receitas_diferidas_cp,     existingRow?.receitas_diferidas_cp),
    receitas_diferidas_lp:     pick(balanco.receitas_diferidas_lp,     existingRow?.receitas_diferidas_lp),
    prov_contingencias:        pick(balanco.prov_contingencias,        existingRow?.prov_contingencias),
    patrimonio_liquido:        pick(balanco.patrimonio_liquido,        existingRow?.patrimonio_liquido),
    patrimonio_social:         pick(balanco.patrimonio_social,         existingRow?.patrimonio_social),
    fornecedores:              pick(balanco.fornecedores,              existingRow?.fornecedores),
    obrig_trabalhistas:        pick(balanco.obrig_trabalhistas,        existingRow?.obrig_trabalhistas),
    adiantamentos:             pick(balanco.adiantamentos,             existingRow?.adiantamentos),
    intangivel:                pick(balanco.intangivel,                existingRow?.intangivel),
    despesas_antecipadas:      pick(balanco.despesas_antecipadas,      existingRow?.despesas_antecipadas),
    contas_receber_lp:         pick(balanco.contas_receber_lp,         existingRow?.contas_receber_lp),
    investimentos:             pick(balanco.investimentos,             existingRow?.investimentos),
    provisao_ferias:           pick(balanco.provisao_ferias,           existingRow?.provisao_ferias),
    fornecedores_lp:           pick(balanco.fornecedores_lp,           existingRow?.fornecedores_lp),
    // DRE — aba DRE (quando disponível para o período); caso contrário preserva existente
    receita_bruta:             pickDRE(dre?.receita_bruta,             existingRow?.receita_bruta),
    receita_liquida:           pickDRE(dre?.receita_liquida,           existingRow?.receita_liquida),
    custos_futebol:            pickDRE(dre?.custos_futebol,            existingRow?.custos_futebol),
    superavit_bruto:           pickDRE(dre?.superavit_bruto,           existingRow?.superavit_bruto),
    despesas_operacionais:     pickDRE(dre?.despesas_operacionais,     existingRow?.despesas_operacionais),
    resultado_financeiro:      pickDRE(dre?.resultado_financeiro,      existingRow?.resultado_financeiro),
    resultado_exercicio:       pickDRE(dre?.resultado_exercicio,       existingRow?.resultado_exercicio),
    resultado_acumulado:       pickDRE(dre?.resultado_acumulado,       existingRow?.resultado_acumulado),
    rec_patrocinio:            pickDRE(dre?.rec_patrocinio,            existingRow?.rec_patrocinio),
    rec_transmissao:           pickDRE(dre?.rec_transmissao,           existingRow?.rec_transmissao),
    rec_bilheteria:            pickDRE(dre?.rec_bilheteria,            existingRow?.rec_bilheteria),
    rec_registros:             pickDRE(dre?.rec_registros,             existingRow?.rec_registros),
    rec_desenvolvimento:       pickDRE(dre?.rec_desenvolvimento,       existingRow?.rec_desenvolvimento),
    rec_academy:               pickDRE(dre?.rec_academy,               existingRow?.rec_academy),
    rec_financeiras:           pickDRE(dre?.rec_financeiras,           existingRow?.rec_financeiras),
    custo_selecao_principal:   pickDRE(dre?.custo_selecao_principal,   existingRow?.custo_selecao_principal),
    custo_selecao_base:        pickDRE(dre?.custo_selecao_base,        existingRow?.custo_selecao_base),
    custo_selecao_femininas:   pickDRE(dre?.custo_selecao_femininas,   existingRow?.custo_selecao_femininas),
    custo_fomento:             pickDRE(dre?.custo_fomento,             existingRow?.custo_fomento),
    desp_pessoal:              pickDRE(dre?.desp_pessoal,              existingRow?.desp_pessoal),
    desp_administrativas:      pickDRE(dre?.desp_administrativas,      existingRow?.desp_administrativas),
    desp_impostos_taxas:       pickDRE(dre?.desp_impostos_taxas,       existingRow?.desp_impostos_taxas),
    res_fin_receitas:          pickDRE(dre?.res_fin_receitas,          existingRow?.res_fin_receitas),
    res_fin_despesas:          pickDRE(dre?.res_fin_despesas,          existingRow?.res_fin_despesas),
    res_fin_cambial:           pickDRE(dre?.res_fin_cambial,           existingRow?.res_fin_cambial),
    programas_desenvolvimento: FORCE ? null : (existingRow?.programas_desenvolvimento ?? null),
    dados_raw: {
      ...existingRaw,
      _balancete_hash: balanceteHash,
      _balancete_extracted: new Date().toISOString(),
      _sources: {
        ...(existingRaw._sources || {}),
        balancete: { filename, processed_at: new Date().toISOString(), method: 'dfs_direct' },
        ...(dre ? { dre_aba: { filename, processed_at: new Date().toISOString(), method: 'direct' } } : {})
      }
    },
    updated_at: new Date().toISOString()
  }

  const { error } = await supabase
    .from(tbl('dados_financeiros'))
    .upsert(row, { onConflict: 'periodo' })
  if (error) throw new Error(`Supabase upsert: ${error.message}`)

  const dreStatus = dre ? `DRE ✓ resultado: ${row.resultado_exercicio?.toLocaleString('pt-BR')}` : 'DRE — período ausente na aba'
  console.log(`   ✅ ${periodo} — ativo_total: ${row.ativo_total?.toLocaleString('pt-BR')}, PL: ${row.patrimonio_liquido?.toLocaleString('pt-BR')} | ${dreStatus}`)
  return { ok: true, periodo }
}

// ── Modo balancete multi-período ───────────────────────────────────────────────
async function mainFromBalancete(filePath) {
  const filename = basename(filePath)
  console.log(`\n🚀 Modo Balancete Multi-Período`)
  console.log(`   Arquivo: ${filename}`)
  console.log(`   Tabela:  ${tbl('dados_financeiros')}\n`)

  const bytes = readFileSync(filePath)
  const workbook = XLSX.read(bytes, { type: 'buffer' })

  const balanceteSheetName = workbook.SheetNames.find(n =>
    BALANCETE_SHEET_NAMES.some(b => n.toLowerCase().includes(b.toLowerCase()))
  )
  if (!balanceteSheetName) {
    console.error(`❌ Aba de balancete não encontrada. Abas: ${workbook.SheetNames.join(', ')}`)
    process.exit(1)
  }
  console.log(`   Aba: ${balanceteSheetName}`)

  const rawPeriodos = getAllBalancetePeriods(workbook, balanceteSheetName)
  let periodos = [...new Set(rawPeriodos.map(s => periodStringToYearMonth(s)).filter(Boolean))].sort()
  if (FROM_PERIODO) {
    periodos = periodos.filter(p => p >= FROM_PERIODO)
    console.log(`   Filtrando a partir de: ${FROM_PERIODO}`)
  }
  console.log(`   Períodos (${periodos.length}): ${periodos.join(', ')}\n`)

  const results = { ok: [], skip: [], error: [] }

  for (let i = 0; i < periodos.length; i++) {
    const periodo = periodos[i]
    try {
      const r = await processBalancetePeriodo(workbook, balanceteSheetName, periodo, filename)
      if (r.skipped) results.skip.push(periodo)
      else if (r.ok) results.ok.push(periodo)
      else results.skip.push(periodo)
    } catch (err) {
      console.error(`   ❌ ${periodo}: ${err.message}`)
      results.error.push({ periodo, error: err.message })
    }
    if (i < periodos.length - 1) await new Promise(r => setTimeout(r, 20_000))
  }

  console.log('\n══════════════════════════════════════════════')
  console.log(`✅ Processados: ${results.ok.length}  |  ⏭️ Pulados: ${results.skip.length}  |  ❌ Erros: ${results.error.length}`)
  if (results.ok.length)  console.log('   OK:',      results.ok.join(', '))
  if (results.skip.length) console.log('   Pulados:', results.skip.join(', '))
  if (results.error.length) results.error.forEach(e => console.log(`   Erro ${e.periodo}: ${e.error}`))
}

// ── Processar um arquivo ───────────────────────────────────────────────────────
async function processFile(filePath, periodo) {
  const filename = basename(filePath)
  console.log(`\n📄 ${filename} → ${periodo}`)

  const bytes = readFileSync(filePath)
  const workbook = XLSX.read(bytes, { type: 'buffer' })

  const balanceteSheetName = workbook.SheetNames.find(n =>
    BALANCETE_SHEET_NAMES.some(b => n.toLowerCase().includes(b.toLowerCase()))
  )
  const hasBalancete = !!balanceteSheetName

  const sheetText = xlsxToText(workbook, ABAS_ALVO)
  let balanceteText = ''
  if (hasBalancete) {
    balanceteText = balanceteToText(workbook, balanceteSheetName, periodo)
  }
  const balanceteEfetivo = balanceteText.length > 200
  const balanceteHash = balanceteEfetivo ? hashText(balanceteText) : null

  // Verificar hash existente
  const { data: existingRow } = await supabase
    .from(tbl('dados_financeiros'))
    .select('*')
    .eq('periodo', periodo)
    .maybeSingle()

  const storedHash = existingRow?.dados_raw?._balancete_hash ?? null
  const balanceteUnchanged = balanceteHash && storedHash && balanceteHash === storedHash

  const textoCompleto = (!balanceteUnchanged && balanceteEfetivo)
    ? sheetText + '\n\n' + balanceteText
    : sheetText

  const prompt = (!balanceteUnchanged && balanceteEfetivo)
    ? buildHybridPrompt(periodo, filename, balanceteSheetName)
    : buildPrompt(periodo, filename)

  console.log(`   📊 Texto: ${textoCompleto.length} chars | balancete: ${balanceteEfetivo} | unchanged: ${!!balanceteUnchanged}`)

  // ── Chamar Claude ──
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `## CONTEÚDO: ${filename}\n\n${textoCompleto}\n\n---\n\n${prompt}` }]
      }]
    })
  })
  clearTimeout(timer)

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Claude ${resp.status}: ${err.slice(0, 300)}`)
  }

  const claudeData = await resp.json()
  const rawText = claudeData.content?.[0]?.text || ''
  const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude não retornou JSON válido')

  const dados = JSON.parse(jsonMatch[1] || jsonMatch[0])
  const existingRaw = existingRow?.dados_raw || {}
  const mergedRaw = deepMerge(existingRaw, dados, 'incoming')
  mergedRaw._balancete_hash = balanceteHash ?? (existingRaw._balancete_hash ?? null)
  mergedRaw._sources = {
    ...(existingRaw._sources || {}),
    dfs: { filename, processed_at: new Date().toISOString() },
    ...(!balanceteUnchanged && hasBalancete ? { balancete: { filename, processed_at: new Date().toISOString(), embedded: true } } : {})
  }

  const pick = (inc, ex) => (inc !== null && inc !== undefined) ? inc : ex

  const row = {
    periodo,
    source_file: filename,
    receita_bruta:           pick(dados.dre?.receita_bruta, existingRow?.receita_bruta),
    receita_liquida:         pick(dados.dre?.receita_liquida, existingRow?.receita_liquida),
    custos_futebol:          pick(dados.dre?.custos_futebol, existingRow?.custos_futebol),
    superavit_bruto:         pick(dados.dre?.superavit_bruto, existingRow?.superavit_bruto),
    despesas_operacionais:   pick(dados.dre?.despesas_operacionais, existingRow?.despesas_operacionais),
    resultado_financeiro:    pick(dados.dre?.resultado_financeiro, existingRow?.resultado_financeiro),
    resultado_exercicio:     pick(dados.dre?.resultado_exercicio, existingRow?.resultado_exercicio),
    rec_patrocinio:          pick(dados.receitas?.patrocinio, existingRow?.rec_patrocinio),
    rec_transmissao:         pick(dados.receitas?.transmissao, existingRow?.rec_transmissao),
    rec_bilheteria:          pick(dados.receitas?.bilheteria, existingRow?.rec_bilheteria),
    rec_registros:           pick(dados.receitas?.registros, existingRow?.rec_registros),
    rec_desenvolvimento:     pick(dados.receitas?.desenvolvimento, existingRow?.rec_desenvolvimento),
    rec_academy:             pick(dados.receitas?.academy, existingRow?.rec_academy),
    rec_financeiras:         pick(dados.resultado_financeiro?.receitas_financeiras, existingRow?.rec_financeiras),
    custo_selecao_principal: pick(dados.custos_futebol?.selecao_principal, existingRow?.custo_selecao_principal),
    custo_selecao_base:      pick(dados.custos_futebol?.selecoes_base, existingRow?.custo_selecao_base),
    custo_selecao_femininas: pick(dados.custos_futebol?.selecoes_femininas, existingRow?.custo_selecao_femininas),
    custo_fomento:           pick(dados.custos_futebol?.fomento, existingRow?.custo_fomento),
    desp_pessoal:            pick(dados.despesas?.pessoal, existingRow?.desp_pessoal),
    desp_administrativas:    pick(dados.despesas?.administrativas, existingRow?.desp_administrativas),
    desp_impostos_taxas:     pick(dados.despesas?.impostos_taxas, existingRow?.desp_impostos_taxas),
    res_fin_receitas:        pick(dados.resultado_financeiro?.receitas_financeiras, existingRow?.res_fin_receitas),
    res_fin_despesas:        pick(dados.resultado_financeiro?.despesas_financeiras, existingRow?.res_fin_despesas),
    res_fin_cambial:         pick(dados.resultado_financeiro?.variacao_cambial, existingRow?.res_fin_cambial),
    ativo_total:             pick(dados.balanco?.ativo_total, existingRow?.ativo_total),
    ativo_circulante:        pick(dados.balanco?.ativo_circulante, existingRow?.ativo_circulante),
    caixa_equivalentes:      pick(dados.balanco?.caixa_equivalentes, existingRow?.caixa_equivalentes),
    contas_receber:          pick(dados.balanco?.contas_receber, existingRow?.contas_receber),
    tributos_recuperar:      pick(dados.balanco?.tributos_recuperar, existingRow?.tributos_recuperar),
    depositos_judiciais:     pick(dados.balanco?.depositos_judiciais, existingRow?.depositos_judiciais),
    imobilizado:             pick(dados.balanco?.imobilizado, existingRow?.imobilizado),
    passivo_circulante:      pick(dados.balanco?.passivo_circulante, existingRow?.passivo_circulante),
    receitas_diferidas_cp:   pick(dados.balanco?.receitas_diferidas_cp, existingRow?.receitas_diferidas_cp),
    receitas_diferidas_lp:   pick(dados.balanco?.receitas_diferidas_lp, existingRow?.receitas_diferidas_lp),
    prov_contingencias:      pick(dados.balanco?.prov_contingencias, existingRow?.prov_contingencias),
    patrimonio_liquido:      pick(dados.balanco?.patrimonio_liquido, existingRow?.patrimonio_liquido),
    patrimonio_social:       pick(dados.balanco?.patrimonio_social, existingRow?.patrimonio_social),
    fornecedores:            pick(dados.balanco?.fornecedores, existingRow?.fornecedores),
    obrig_trabalhistas:      pick(dados.balanco?.obrig_trabalhistas, existingRow?.obrig_trabalhistas),
    adiantamentos:           pick(dados.balanco?.adiantamentos, existingRow?.adiantamentos),
    intangivel:              pick(dados.balanco?.intangivel, existingRow?.intangivel),
    resultado_acumulado:     pick(dados.balanco?.resultado_acumulado, existingRow?.resultado_acumulado),
    despesas_antecipadas:    pick(dados.balanco?.despesas_antecipadas, existingRow?.despesas_antecipadas),
    contas_receber_lp:       pick(dados.balanco?.contas_receber_lp, existingRow?.contas_receber_lp),
    investimentos:           pick(dados.balanco?.investimentos, existingRow?.investimentos),
    programas_desenvolvimento: pick(dados.balanco?.programas_desenvolvimento, existingRow?.programas_desenvolvimento),
    provisao_ferias:         pick(dados.balanco?.provisao_ferias, existingRow?.provisao_ferias),
    fornecedores_lp:         pick(dados.balanco?.fornecedores_lp, existingRow?.fornecedores_lp),
    fluxo_operacional:       pick(dados.dfc?.fluxo_operacional, existingRow?.fluxo_operacional),
    fluxo_investimento:      pick(dados.dfc?.fluxo_investimento, existingRow?.fluxo_investimento),
    variacao_caixa:          pick(dados.dfc?.variacao_total, existingRow?.variacao_caixa),
    dados_raw: mergedRaw,
    updated_at: new Date().toISOString()
  }

  const { error } = await supabase
    .from(tbl('dados_financeiros'))
    .upsert(row, { onConflict: 'periodo' })
  if (error) throw new Error(`Supabase upsert: ${error.message}`)

  console.log(`   ✅ Salvo — receita_bruta: ${row.receita_bruta}, ativo_total: ${row.ativo_total}`)
  return { ok: true, periodo }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const files = readdirSync(FOLDER)
    .filter(f => f.match(/\.xlsx?$/i))
    .sort()

  if (files.length === 0) {
    console.error(`❌ Nenhum arquivo .xlsx encontrado em: ${FOLDER}`)
    process.exit(1)
  }

  console.log(`\n🚀 Bulk Load — ${files.length} arquivo(s) em: ${FOLDER}`)
  console.log('   Tabela:', tbl('dados_financeiros'), '\n')

  const results = { ok: [], skip: [], error: [] }

  for (const f of files) {
    const filePath = join(FOLDER, f)
    const periodo = detectPeriodo(f)
    if (!periodo) {
      console.warn(`⚠️  Período não detectado em "${f}" — pulando. Renomeie o arquivo para conter "YYYY-MM" ou "MM-YYYY".`)
      results.skip.push(f)
      continue
    }

    try {
      await processFile(filePath, periodo)
      results.ok.push(periodo)
    } catch (err) {
      console.error(`   ❌ Erro: ${err.message}`)
      results.error.push({ periodo, file: f, error: err.message })
    }

    // Aguardar 2s entre arquivos para não saturar a API
    if (files.indexOf(f) < files.length - 1) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  console.log('\n══════════════════════════════════════════════')
  console.log(`✅ Processados: ${results.ok.length}  |  ⚠️ Pulados: ${results.skip.length}  |  ❌ Erros: ${results.error.length}`)
  if (results.ok.length) console.log('   Períodos OK:', results.ok.join(', '))
  if (results.skip.length) console.log('   Pulados:', results.skip.join(', '))
  if (results.error.length) {
    console.log('   Erros:')
    results.error.forEach(e => console.log(`     ${e.periodo || e.file}: ${e.error}`))
  }
}

if (isBulkMode) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
} else {
  mainFromBalancete(ARG).catch(e => { console.error('Fatal:', e.message); process.exit(1) })
}
