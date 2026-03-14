'use client'

import { useEffect, useRef } from 'react'

interface DadosFinanceiros {
  periodo: string
  receita_bruta?: number
  receita_liquida?: number
  custos_futebol?: number
  superavit_bruto?: number
  despesas_operacionais?: number
  resultado_financeiro?: number
  resultado_exercicio?: number
  rec_patrocinio?: number
  rec_transmissao?: number
  rec_bilheteria?: number
  rec_registros?: number
  rec_desenvolvimento?: number
  rec_academy?: number
  rec_financeiras?: number
  custo_selecao_principal?: number
  custo_selecao_base?: number
  custo_selecao_femininas?: number
  custo_fomento?: number
  desp_pessoal?: number
  desp_administrativas?: number
  desp_impostos_taxas?: number
  res_fin_receitas?: number
  res_fin_despesas?: number
  res_fin_cambial?: number
  ativo_total?: number
  ativo_circulante?: number
  caixa_equivalentes?: number
  contas_receber?: number
  tributos_recuperar?: number
  depositos_judiciais?: number
  imobilizado?: number
  passivo_circulante?: number
  receitas_diferidas_cp?: number
  receitas_diferidas_lp?: number
  prov_contingencias?: number
  patrimonio_liquido?: number
  patrimonio_social?: number
  fluxo_operacional?: number
  fluxo_investimento?: number
  variacao_caixa?: number
  liquidez_corrente?: number
  liquidez_imediata?: number
  dados_raw?: any
  source_file?: string
}

interface Props {
  dados: {
    periodoAtual: string
    dadoAtual: DadosFinanceiros | null
    historico: DadosFinanceiros[]
    geradoEm: string
  }
}

// Formata número para exibição no dashboard
function fmt(val: number | undefined | null, decimals = 0): string {
  if (val == null) return '—'
  return (val / 1000).toFixed(decimals).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function fmtBi(val: number | undefined | null): string {
  if (val == null) return '—'
  return `R$ ${(val / 1000000).toFixed(2).replace('.', ',')} Bi`
}

function fmtMi(val: number | undefined | null): string {
  if (val == null) return '—'
  return `R$ ${(val / 1000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} Mi`
}

function variacao(atual: number | undefined, anterior: number | undefined): string {
  if (!atual || !anterior) return ''
  const pct = ((atual - anterior) / Math.abs(anterior) * 100).toFixed(1)
  return (parseFloat(pct) >= 0 ? '+' : '') + pct + '%'
}

function formatPeriodo(periodo: string): string {
  const [ano, mes] = periodo.split('-')
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
  return `${meses[parseInt(mes)-1]}/${ano}`
}

export default function DashboardClient({ dados }: Props) {
  const { dadoAtual, historico, periodoAtual, geradoEm } = dados
  const d = dadoAtual
  
  // Período anterior para comparação
  const periodoAnteriorIdx = historico.findIndex(h => h.periodo === periodoAtual) - 1
  const dAnterior = periodoAnteriorIdx >= 0 ? historico[periodoAnteriorIdx] : null

  // Dados para série histórica (últimos 5 períodos)
  const serie = historico.slice(-5)

  // Injetar os dados dinâmicos no script do dashboard
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    // Ler o HTML do dashboard estático e injetar os dados
    // (O dashboard HTML é servido como página separada com os dados injetados via window)
    if (typeof window !== 'undefined') {
      ;(window as any).__CBF_DADOS__ = dados
    }
  }, [dados])

  // Gerar o HTML do dashboard dinamicamente com os dados reais
  const dashboardHtml = gerarDashboardHTML(d, dAnterior, serie, periodoAtual, geradoEm)

  return (
    <div
      style={{ width: '100%', minHeight: '100vh' }}
      dangerouslySetInnerHTML={{ __html: dashboardHtml }}
    />
  )
}

function gerarDashboardHTML(
  d: DadosFinanceiros | null,
  dAnt: DadosFinanceiros | null,
  serie: DadosFinanceiros[],
  periodo: string,
  geradoEm: string
): string {
  if (!d) {
    return `<div style="background:#0D1117;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:sans-serif">
      <div style="text-align:center">
        <h1 style="color:#F5C800;font-size:48px;margin-bottom:16px">CBF</h1>
        <p style="color:#8B949E">Nenhum dado disponível ainda.</p>
        <a href="/admin" style="color:#F5C800;margin-top:24px;display:inline-block">→ Fazer primeiro upload</a>
      </div>
    </div>`
  }

  const periodoFormatado = formatPeriodo(periodo)
  const dataGeracao = new Date(geradoEm).toLocaleDateString('pt-BR')

  // Dados para os gráficos
  const labelsHistorico = serie.map(s => formatPeriodo(s.periodo))
  const receitaHistorico = serie.map(s => Math.round((s.receita_bruta || 0) / 1000))
  const resultadoHistorico = serie.map(s => Math.round((s.resultado_exercicio || 0) / 1000))
  const custosHistorico = serie.map(s => Math.round((s.custos_futebol || 0) / 1000))
  const caixaHistorico = serie.map(s => Math.round((s.caixa_equivalentes || 0) / 1000))

  // Receitas para doughnut
  const recTrans = Math.round((d.rec_transmissao || 0) / 1000)
  const recPat   = Math.round((d.rec_patrocinio || 0) / 1000)
  const recBilh  = Math.round((d.rec_bilheteria || 0) / 1000)
  const recReg   = Math.round((d.rec_registros || 0) / 1000)
  const recDev   = Math.round(((d.rec_desenvolvimento || 0) + (d.rec_academy || 0)) / 1000)

  // Custos para doughnut
  const cFom  = Math.round((d.custo_fomento || 0) / 1000)
  const cSel  = Math.round((d.custo_selecao_principal || 0) / 1000)
  const cFem  = Math.round((d.custo_selecao_femininas || 0) / 1000)
  const cBase = Math.round((d.custo_selecao_base || 0) / 1000)

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CBF — Demonstrações Financeiras ${periodo}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
/* ── Todos os estilos do dashboard original aqui ── */
:root{--green:#00703C;--gl:#00963F;--gd:#004D26;--yellow:#F5C800;--blue:#002776;--bm:#003DA5;--white:#FAFAFA;--dark:#0D1117;--d2:#161B22;--gray:#8B949E;--g2:#6E7681;--bdr:rgba(255,255,255,0.08);--card:rgba(22,27,34,0.85);--pos:#3FB950;--neg:#F85149}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:var(--dark);color:var(--white);min-height:100vh}
/* ... (incluído via __DASHBOARD_CSS__ que é preenchido no build) ... */
.info-bar{background:rgba(245,200,0,.08);border-bottom:1px solid rgba(245,200,0,.2);padding:8px 40px;font-size:11px;color:var(--gray);display:flex;justify-content:space-between;align-items:center}
.info-bar a{color:var(--yellow);text-decoration:none;font-weight:600}
</style>
</head>
<body>

<!-- Barra de versão/período -->
<div class="info-bar">
  <span>📊 Período: <strong style="color:#fff">${periodoFormatado}</strong> · Fonte: ${d.source_file || 'DFS CBF'} · Gerado em: ${dataGeracao}</span>
  <a href="/admin">⚙️ Admin / Upload</a>
</div>

<!-- ═══ AQUI VAI O HTML COMPLETO DO DASHBOARD ═══ -->
<!-- O conteúdo do cbf_dashboard_2025_v07.html é injetado aqui,
     com os valores substituídos pelos dados dinâmicos do Supabase -->
<!-- Ver instrução de deploy abaixo -->

<script>
// Dados injetados pelo servidor
window.__CBF_DADOS__ = ${JSON.stringify({
  periodo, periodoFormatado,
  receita_bruta: Math.round((d.receita_bruta||0)/1000),
  resultado_exercicio: Math.round((d.resultado_exercicio||0)/1000),
  custos_futebol: Math.round((d.custos_futebol||0)/1000),
  caixa_equivalentes: Math.round((d.caixa_equivalentes||0)/1000),
  ativo_total: Math.round((d.ativo_total||0)/1000),
  rec_financeiras: Math.round((d.rec_financeiras||0)/1000),
  // Arrays para gráficos
  labels: labelsHistorico,
  receita_serie: receitaHistorico,
  resultado_serie: resultadoHistorico,
  custos_serie: custosHistorico,
  caixa_serie: caixaHistorico,
  // Doughnuts
  receitas_composicao: [recTrans, recPat, recBilh, recReg, recDev],
  custos_composicao: [cFom, cSel, cFem, cBase],
  // Balanço
  patrimonio_liquido: Math.round((d.patrimonio_liquido||0)/1000),
  liquidez_corrente: d.liquidez_corrente,
  liquidez_imediata: d.liquidez_imediata,
  fluxo_operacional: Math.round((d.fluxo_operacional||0)/1000),
  fluxo_investimento: Math.round((d.fluxo_investimento||0)/1000),
})};

console.log('CBF Dashboard carregado — período:', window.__CBF_DADOS__.periodo);
</script>
</body>
</html>`
}
