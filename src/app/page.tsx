import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0

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

  const atual = todos?.find(d => d.periodo === periodoAtual) || todos?.[todos?.length - 1]

  return {
    periodoAtual,
    dadoAtual: atual || null,
    historico: todos || [],
    geradoEm: new Date().toISOString()
  }
}

export default async function Home() {
  const dados = await getDados()
  const d = dados.dadoAtual

  // Montar o objeto window.__CBF_DADOS__ que o dashboard.html consome
  const cbfDados = d ? {
    periodo: dados.periodoAtual,
    periodoFormatado: formatPeriodo(dados.periodoAtual),
    source_file: d.source_file,
    geradoEm: dados.geradoEm,

    // KPIs
    receita_bruta:        Number(d.receita_bruta),
    receita_liquida:      Number(d.receita_liquida),
    resultado_exercicio:  Number(d.resultado_exercicio),
    custos_futebol:       Number(d.custos_futebol),
    caixa_equivalentes:   Number(d.caixa_equivalentes),
    ativo_total:          Number(d.ativo_total),
    rec_financeiras:      Number(d.rec_financeiras),
    patrimonio_liquido:   Number(d.patrimonio_liquido),
    liquidez_corrente:    Number(d.liquidez_corrente),
    liquidez_imediata:    Number(d.liquidez_imediata),
    fluxo_operacional:    Number(d.fluxo_operacional),
    fluxo_investimento:   Number(d.fluxo_investimento),

    // Séries históricas para gráficos
    labels:          dados.historico.map(h => formatPeriodo(h.periodo)),
    receita_serie:   dados.historico.map(h => Math.round(Number(h.receita_bruta) / 1000)),
    resultado_serie: dados.historico.map(h => Math.round(Number(h.resultado_exercicio) / 1000)),
    custos_serie:    dados.historico.map(h => Math.round(Number(h.custos_futebol) / 1000)),
    caixa_serie:     dados.historico.map(h => Math.round(Number(h.caixa_equivalentes) / 1000)),

    // Doughnuts receitas
    receitas_composicao: [
      Math.round(Number(d.rec_transmissao) / 1000),
      Math.round(Number(d.rec_patrocinio) / 1000),
      Math.round(Number(d.rec_bilheteria) / 1000),
      Math.round(Number(d.rec_registros) / 1000),
      Math.round((Number(d.rec_desenvolvimento) + Number(d.rec_academy)) / 1000),
    ],

    // Doughnut custos
    custos_composicao: [
      Math.round(Number(d.custo_fomento) / 1000),
      Math.round(Number(d.custo_selecao_principal) / 1000),
      Math.round(Number(d.custo_selecao_femininas) / 1000),
      Math.round(Number(d.custo_selecao_base) / 1000),
    ],

    // Seleções
    custo_selecao_principal:  Math.round(Number(d.custo_selecao_principal) / 1000),
    custo_selecao_base:       Math.round(Number(d.custo_selecao_base) / 1000),
    custo_selecao_femininas:  Math.round(Number(d.custo_selecao_femininas) / 1000),
    custo_fomento:            Math.round(Number(d.custo_fomento) / 1000),

    // Despesas operacionais
    desp_pessoal:         Math.round(Number(d.desp_pessoal) / 1000),
    desp_administrativas: Math.round(Number(d.desp_administrativas) / 1000),
    desp_impostos_taxas:  Math.round(Number(d.desp_impostos_taxas) / 1000),

    // Balanço
    ativo_circulante:     Number(d.ativo_circulante),
    passivo_circulante:   Number(d.passivo_circulante),
    contas_receber:       Number(d.contas_receber),
    tributos_recuperar:   Number(d.tributos_recuperar),
    depositos_judiciais:  Number(d.depositos_judiciais),
    imobilizado:          Number(d.imobilizado),
    receitas_diferidas_cp: Number(d.receitas_diferidas_cp),
    receitas_diferidas_lp: Number(d.receitas_diferidas_lp),
    prov_contingencias:   Number(d.prov_contingencias),
    patrimonio_social:    Number(d.patrimonio_social),
  } : null

  // Ler o dashboard.html e injetar os dados
  const fs = await import('fs')
  const path = await import('path')
  const htmlPath = path.join(process.cwd(), 'public', 'dashboard.html')
  let html = fs.readFileSync(htmlPath, 'utf-8')

  // Injetar dados e barra de info antes do </body>
  const infoBar = d ? `
  <div style="position:fixed;bottom:0;left:0;right:0;background:rgba(0,112,60,.9);color:#fff;font-size:11px;padding:4px 16px;display:flex;justify-content:space-between;z-index:9999;font-family:'DM Sans',sans-serif">
    <span>📊 ${formatPeriodo(dados.periodoAtual)} · ${d.source_file || 'DFS CBF'} · Atualizado: ${new Date(dados.geradoEm).toLocaleString('pt-BR')}</span>
    <a href="/admin" style="color:#F5C800;text-decoration:none;font-weight:600">⚙️ Admin</a>
  </div>` : ''

  const script = `
<script>
window.__CBF_DADOS__ = ${JSON.stringify(cbfDados)};
</script>`

  html = html.replace('</body>', `${script}${infoBar}</body>`)

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
}

function formatPeriodo(periodo: string): string {
  const [ano, mes] = periodo.split('-')
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
  return `${meses[parseInt(mes)-1]}/${ano}`
}
