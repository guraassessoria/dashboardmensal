import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function formatPeriodo(periodo: string): string {
  if (!periodo) return ''
  const [ano, mes] = periodo.split('-')
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
  return `${meses[parseInt(mes)-1]}/${ano}`
}

async function getDados() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const { data: config } = await supabase
    .from('configuracao')
    .select('valor')
    .eq('chave', 'periodo_atual')
    .single()

  const periodoAtual = config?.valor || '2025-12'

  const { data: todos } = await supabase
    .from('dados_financeiros')
    .select('*')
    .order('periodo', { ascending: true })

  const lista = todos || []
  const atual = lista.find((d: any) => d.periodo === periodoAtual) || lista[lista.length - 1]

  return {
    periodoAtual,
    dadoAtual: atual || null,
    historico: lista,
    geradoEm: new Date().toISOString()
  }
}

export default async function Home() {
  const dados = await getDados()
  const d = dados.dadoAtual

  const cbfDados = d ? {
    periodo: dados.periodoAtual,
    periodoFormatado: formatPeriodo(dados.periodoAtual),
    source_file: d.source_file,
    geradoEm: dados.geradoEm,

    // KPIs principais (valores brutos em R$ mil)
    receita_bruta:        Number(d.receita_bruta),
    receita_liquida:      Number(d.receita_liquida),
    resultado_exercicio:  Number(d.resultado_exercicio),
    custos_futebol:       Math.abs(Number(d.custos_futebol)),
    caixa_equivalentes:   Number(d.caixa_equivalentes),
    ativo_total:          Number(d.ativo_total),
    rec_financeiras:      Number(d.rec_financeiras),
    patrimonio_liquido:   Number(d.patrimonio_liquido),
    liquidez_corrente:    Number(d.liquidez_corrente),
    liquidez_imediata:    Number(d.liquidez_imediata),
    fluxo_operacional:    Number(d.fluxo_operacional),
    fluxo_investimento:   Number(d.fluxo_investimento),

    // Séries históricas (em R$ Mi = dividido por 1000)
    labels:          dados.historico.map((h: any) => formatPeriodo(h.periodo)),
    receita_serie:   dados.historico.map((h: any) => Math.round(Number(h.receita_bruta) / 1000)),
    resultado_serie: dados.historico.map((h: any) => Math.round(Number(h.resultado_exercicio) / 1000)),
    custos_serie:    dados.historico.map((h: any) => Math.round(Math.abs(Number(h.custos_futebol)) / 1000)),
    caixa_serie:     dados.historico.map((h: any) => Math.round(Number(h.caixa_equivalentes) / 1000)),

    // Receitas composição doughnut (em R$ Mi)
    receitas_composicao: [
      Math.round(Math.abs(Number(d.rec_transmissao)) / 1000),
      Math.round(Math.abs(Number(d.rec_patrocinio)) / 1000),
      Math.round(Math.abs(Number(d.rec_bilheteria)) / 1000),
      Math.round(Math.abs(Number(d.rec_registros)) / 1000),
      Math.round((Math.abs(Number(d.rec_desenvolvimento)) + Math.abs(Number(d.rec_academy))) / 1000),
    ],

    // Custos composição doughnut (em R$ Mi)
    custos_composicao: [
      Math.round(Math.abs(Number(d.custo_fomento)) / 1000),
      Math.round(Math.abs(Number(d.custo_selecao_principal)) / 1000),
      Math.round(Math.abs(Number(d.custo_selecao_femininas)) / 1000),
      Math.round(Math.abs(Number(d.custo_selecao_base)) / 1000),
    ],

    // Detalhes seleções e despesas (em R$ Mi)
    custo_selecao_principal:  Math.round(Math.abs(Number(d.custo_selecao_principal)) / 1000),
    custo_selecao_base:       Math.round(Math.abs(Number(d.custo_selecao_base)) / 1000),
    custo_selecao_femininas:  Math.round(Math.abs(Number(d.custo_selecao_femininas)) / 1000),
    custo_fomento:            Math.round(Math.abs(Number(d.custo_fomento)) / 1000),
    desp_pessoal:             Math.round(Math.abs(Number(d.desp_pessoal)) / 1000),
    desp_administrativas:     Math.round(Math.abs(Number(d.desp_administrativas)) / 1000),
    desp_impostos_taxas:      Math.round(Math.abs(Number(d.desp_impostos_taxas)) / 1000),

    // Balanço (valores brutos)
    ativo_circulante:      Number(d.ativo_circulante),
    passivo_circulante:    Number(d.passivo_circulante),
    contas_receber:        Number(d.contas_receber),
    tributos_recuperar:    Number(d.tributos_recuperar),
    depositos_judiciais:   Number(d.depositos_judiciais),
    imobilizado:           Number(d.imobilizado),
    receitas_diferidas_cp: Number(d.receitas_diferidas_cp),
    receitas_diferidas_lp: Number(d.receitas_diferidas_lp),
    prov_contingencias:    Number(d.prov_contingencias),
    patrimonio_social:     Number(d.patrimonio_social),
  } : null

  // Ler o dashboard.html e injetar dados
  const htmlPath = join(process.cwd(), 'public', 'dashboard.html')
  let html = readFileSync(htmlPath, 'utf-8')

  // Barra de info no rodapé
  const infoBar = d ? `
<div style="position:fixed;bottom:0;left:0;right:0;background:rgba(0,112,60,.92);backdrop-filter:blur(4px);color:#fff;font-size:11px;padding:5px 20px;display:flex;justify-content:space-between;align-items:center;z-index:9999;font-family:'DM Sans',system-ui,sans-serif">
  <span>📊 <strong>${formatPeriodo(dados.periodoAtual)}</strong> · ${d.source_file || 'DFS CBF'} · Atualizado: ${new Date(dados.geradoEm).toLocaleString('pt-BR')}</span>
  <a href="/admin" style="color:#F5C800;text-decoration:none;font-weight:600;font-size:11px">⚙️ Admin / Upload</a>
</div>` : ''

  // Injetar script de dados ANTES do initCharts()
  const dataScript = `<script>
window.__CBF_DADOS__ = ${JSON.stringify(cbfDados)};
</script>`

  // Inserir o script e a barra antes de </body>
  html = html.replace('</body>', `${dataScript}${infoBar}</body>`)

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
}
