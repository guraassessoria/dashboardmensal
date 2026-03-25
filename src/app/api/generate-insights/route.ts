import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl, isDev } from '@/lib/supabase'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'cbf_admin_token_2025'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

// POST /api/generate-insights — chamado pelo admin após upload=done
// Roda em Vercel serverless (budget próprio, independente da edge function)
export async function POST(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== AUTH_TOKEN) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const { periodo, upload_id } = await req.json()
    if (!periodo) return NextResponse.json({ error: 'periodo obrigatório' }, { status: 400 })

    // Buscar dados financeiros do período
    const { data: dadosRow, error: dadosError } = await supabase
      .from(tbl('dados_financeiros'))
      .select('*')
      .eq('periodo', periodo)
      .single()

    if (dadosError || !dadosRow) {
      return NextResponse.json({ error: 'Dados financeiros não encontrados para o período' }, { status: 404 })
    }

    // Buscar dados do período anterior para comparações
    const { data: anteriores } = await supabase
      .from(tbl('dados_financeiros'))
      .select('*')
      .neq('periodo', periodo)
      .order('periodo', { ascending: false })
      .limit(1)

    const dadosAnteriores = anteriores?.[0] || null
    const mergedRaw = dadosRow.dados_raw || {}
    const sources = mergedRaw._sources || {}
    const bothFilesAvailable = !!sources.dfs && !!sources.balancete

    const insightData = { ...mergedRaw }
    delete insightData.contas_detalhadas
    delete insightData.competicoes

    const insightDataText = `## DADOS FINANCEIROS EXTRAÍDOS\nPeríodo: ${periodo}\n\n\`\`\`json\n${JSON.stringify(insightData, null, 2)}\n\`\`\``
    const insightsPrompt = buildInsightsPrompt(mergedRaw, dadosAnteriores, periodo, dadosRow.source_file || '', bothFilesAvailable)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${insightDataText}\n\n---\n\n${insightsPrompt}` }] }]
      })
    })
    clearTimeout(timeout)

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: `Claude API error: ${err}` }, { status: 500 })
    }

    const claudeData = await response.json()
    const rawText = claudeData.content?.[0]?.text || ''
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Claude não retornou JSON válido' }, { status: 500 })
    }

    const insightsJSON = JSON.parse(jsonMatch[1] || jsonMatch[0])

    const { error: upsertError } = await supabase
      .from(tbl('insights_gerados'))
      .upsert({
        periodo,
        upload_id: upload_id || null,
        conteudo: insightsJSON,
        updated_at: new Date().toISOString()
      }, { onConflict: 'periodo' })

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, periodo })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

function buildInsightsPrompt(dadosExtraidos: any, dadosAnteriores: any, periodo: string, filename: string, bothFiles: boolean): string {
  const anoAtual = periodo.split('-')[0]
  const anoAnterior = dadosAnteriores ? dadosAnteriores.periodo?.split('-')[0] || String(+anoAtual - 1) : String(+anoAtual - 1)

  const filesNote = bothFiles
    ? `\n## FONTES DISPONÍVEIS\nVocê recebeu AMBOS os documentos: Demonstrações Financeiras (DFs) e Balancete.\n`
    : `\n## FONTE DISPONÍVEL\nApenas um documento disponível (${filename}). Análise baseada nos dados disponíveis.\n`

  return `Você é um analista financeiro sênior especializado em demonstrações financeiras de entidades esportivas brasileiras.
Analise os dados extraídos das Demonstrações Financeiras da CBF (período: ${periodo}) e gere insights analíticos detalhados.
${filesNote}

## DADOS EXTRAÍDOS DO PERÍODO ATUAL (${periodo})
${JSON.stringify(dadosExtraidos, null, 2)}

${dadosAnteriores ? `## DADOS DO PERÍODO ANTERIOR (${dadosAnteriores.periodo})\n${JSON.stringify(dadosAnteriores.dados_raw || dadosAnteriores, null, 2)}` : '## DADOS DO PERÍODO ANTERIOR\nNão disponível.'}

## INSTRUÇÕES
Gere insights analíticos para um dashboard financeiro executivo da CBF. Os textos devem ser:
- Profissionais, concisos e objetivos
- Em português brasileiro
- Com valores numéricos formatados (R$ X milhões, R$ X,XX bilhões)
- Use tags HTML inline: <strong> para valores e destaques
- Comparem período atual vs anterior quando houver dados disponíveis

## REGRAS DE CONVENÇÃO CONTÁBIL
- Receita aumenta = BOM | Receita diminui = RUIM
- Custo/Despesa aumenta = RUIM | Custo/Despesa diminui = BOM
- Setas: ▲ para valor que subiu, ▼ para valor que desceu

Retorne APENAS um JSON válido:

\`\`\`json
{
  "resumo_deficit": "Parágrafo analítico sobre o resultado do exercício. Explicar causas, contexto e posição de caixa. Máximo 3-4 frases.",
  "receitas_destaque": "Parágrafo curto (2-3 frases) destacando principais variações de receita.",
  "custos_selecao_principal": { "titulo": "SELEÇÃO PRINCIPAL +/−R$ XMi", "texto": "Detalhamento por subcategoria." },
  "custos_selecao_base": { "titulo": "SELEÇÕES DE BASE +/−R$ XMi", "texto": "Detalhamento por subcategoria." },
  "custos_selecao_femininas": { "titulo": "SELEÇÕES FEMININAS +/−R$ XMi", "texto": "Detalhamento por subcategoria." },
  "custos_fomento": { "titulo": "CONTRIBUIÇÃO AO FOMENTO DO FUTEBOL +/−R$ XMi", "texto": "Detalhamento por subcategoria." },
  "custos_admin_alerta": "Parágrafo analítico sobre despesas administrativas: variação percentual, principais drivers. 2-3 frases.",
  "balanco_ativo": "Composição do ativo: principais itens com valores e percentuais. 2-3 frases.",
  "balanco_passivo": "Nota sobre passivo e PL: receitas diferidas, contingências, patrimônio. 2-3 frases.",
  "balanco_evolucao": "Evolução patrimonial: comparar ativo total entre períodos. 2-3 frases.",
  "indicadores_ebitda": "Cálculo e análise do EBITDA/Margem EBITDA. 2-3 frases.",
  "indicadores_kanitz": "Análise do Índice de Kanitz. 1-2 frases.",
  "indicadores_liquidez_corrente": "Liquidez Corrente: valor, comparação, interpretação. 1-2 frases.",
  "indicadores_liquidez_geral": "Liquidez Geral: valor, comparação, interpretação. 1-2 frases.",
  "indicadores_liquidez_imediata": "Liquidez Imediata: valor, comparação, interpretação. 1-2 frases.",
  "indicadores_dfc": "Análise da DFC: variação total do caixa, componentes operacional e investimento. 2-3 frases.",
  "indicadores_tendencia": "Tendência das disponibilidades ao longo dos anos. 2-3 frases.",
  "historico_perspectiva": "Perspectiva para os próximos 1-2 anos considerando ciclo de competições. 2-3 frases.",
  "nike_banner": "Texto curto sobre o contrato Nike: valor de antecipação, receita registrada, vigência. 1-2 frases.",
  "kpis": {
    "receita_bruta": { "delta": "▼/▲ +/−X% vs ${anoAnterior} (R$X bilhões/milhões)", "sub": "texto complementar curto" },
    "resultado": { "delta": "▼/▲ descrição da variação do resultado", "sub": "" },
    "custos_futebol": { "delta": "▲/▼ +/−X% vs ${anoAnterior} (R$X bilhões)", "sub": "" },
    "caixa": { "delta": "▼/▲ +/−X% vs ${anoAnterior} (R$X bilhões)", "sub": "texto complementar" },
    "ativo_total": { "delta": "▼/▲ +/−X% vs ${anoAnterior} (R$X bilhões)", "sub": "PL: R$ X bilhões" },
    "rec_financeiras": { "delta": "▲/▼ +/−X% vs ${anoAnterior} (R$X milhões)", "sub": "" },
    "transmissao": { "delta": "▼/▲ variação vs anterior", "sub": "% da receita bruta" },
    "patrocinio": { "delta": "▼/▲ variação vs anterior", "sub": "" },
    "bilheteria": { "delta": "▼/▲ variação vs anterior", "sub": "descrição" },
    "registros": { "delta": "▼/▲ variação vs anterior", "sub": "descrição" },
    "desenvolvimento": { "delta": "▼/▲ variação vs anterior", "sub": "descrição" },
    "fomento": { "delta": "▲/▼ variação vs anterior", "sub": "% dos custos" },
    "selecao_principal": { "delta": "▲/▼ variação vs anterior", "sub": "" },
    "selecao_femininas": { "delta": "▲/▼ variação vs anterior", "sub": "" },
    "selecao_base": { "delta": "▲/▼ variação vs anterior", "sub": "" },
    "desp_administrativas": { "delta": "▲/▼ variação vs anterior", "sub": "descrição" },
    "desp_pessoal": { "delta": "▲/▼ variação vs anterior", "sub": "" }
  }
}
\`\`\`

IMPORTANTE: Use os dados REAIS. Todos os valores do xlsx estão em R$ milhares — converta para milhões na apresentação. Retorne APENAS o JSON.`
}
