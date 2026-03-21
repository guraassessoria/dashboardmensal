// supabase/functions/process-upload/index.ts
// Edge Function: ativada via webhook quando arquivo chega no Storage
// Lê o xlsx → parseia localmente → envia texto para Claude API → salva JSON no banco

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import * as XLSX from "https://esm.sh/xlsx@0.18.5"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ── Abas relevantes do xlsx ──
const ABAS_ALVO = [
  "BP", "DRE", "DFC", "DMPL", "DRA",
  "12.Receita Bruta", "13.Custos com futebol",
  "14.Despesas Operacionais", "15.Resultado Financeiro"
]

serve(async (req) => {
  try {
    const body = await req.json()
    const { upload_id, storage_path, periodo, filename, tipo_documento = 'dfs', env = 'prod' } = body
    const isDev = env === 'dev'
    const t = (name: string) => isDev ? `dev_${name}` : name

    console.log(`[${env}] Processando upload: ${filename} | Período: ${periodo} | Tipo: ${tipo_documento}`)

    // ── 1. Atualizar status para 'processing' ──
    await supabase
      .from(t("uploads"))
      .update({ status: "processing" })
      .eq("id", upload_id)

    // ── 2. Baixar o arquivo do Storage ──
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("uploads-cbf")
      .download(storage_path)

    if (downloadError || !fileData) {
      throw new Error(`Erro ao baixar arquivo: ${downloadError?.message}`)
    }

    // Parsear xlsx localmente com SheetJS
    const arrayBuffer = await fileData.arrayBuffer()
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" })
    const sheetText = xlsxToText(workbook)

    // ── 3. Enviar para Claude API com prompt adequado ao tipo ──
    const prompt = tipo_documento === 'balancete'
      ? buildBalancetePrompt(periodo, filename)
      : buildPrompt(periodo, filename)

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `## CONTEÚDO DO ARQUIVO XLSX: ${filename}\n\n${sheetText}\n\n---\n\n${prompt}` }
          ]
        }]
      })
    })

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text()
      throw new Error(`Claude API error: ${err}`)
    }

    const claudeData = await claudeResponse.json()
    const rawText = claudeData.content?.[0]?.text || ""

    // ── 4. Parsear JSON retornado pelo Claude ──
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) ||
                      rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error("Claude não retornou JSON válido")
    }

    const dadosExtraidosRaw = JSON.parse(jsonMatch[1] || jsonMatch[0])

    // Balancete vem em R$ (reais). Converter para R$ milhares para padronizar com DFS.
    const dadosExtraidos = tipo_documento === 'balancete'
      ? convertToThousands(dadosExtraidosRaw)
      : dadosExtraidosRaw

    // ── 5. Salvar no banco (merge com dados existentes) ──
    // Buscar dados já existentes para este período (do outro arquivo)
    const { data: existingRow } = await supabase
      .from(t("dados_financeiros"))
      .select("*")
      .eq("periodo", periodo)
      .single()

    const existingRaw = existingRow?.dados_raw || {}

    // Merge: dados_raw combina ambas as fontes
    const mergedRaw = {
      ...existingRaw,
      ...dadosExtraidos,
      _sources: {
        ...(existingRaw._sources || {}),
        [tipo_documento]: { filename, processed_at: new Date().toISOString() }
      }
    }

    // Construir objeto de dados: novos valores preenchem os que estavam null
    const novosDados = {
      periodo,
      upload_id,
      source_file: filename,

      // DRE
      receita_bruta:          dadosExtraidos.dre?.receita_bruta ?? existingRow?.receita_bruta,
      receita_liquida:        dadosExtraidos.dre?.receita_liquida ?? existingRow?.receita_liquida,
      custos_futebol:         dadosExtraidos.dre?.custos_futebol ?? existingRow?.custos_futebol,
      superavit_bruto:        dadosExtraidos.dre?.superavit_bruto ?? existingRow?.superavit_bruto,
      despesas_operacionais:  dadosExtraidos.dre?.despesas_operacionais ?? existingRow?.despesas_operacionais,
      resultado_financeiro:   dadosExtraidos.dre?.resultado_financeiro ?? existingRow?.resultado_financeiro,
      resultado_exercicio:    dadosExtraidos.dre?.resultado_exercicio ?? existingRow?.resultado_exercicio,

      // Receitas detalhadas
      rec_patrocinio:         dadosExtraidos.receitas?.patrocinio ?? existingRow?.rec_patrocinio,
      rec_transmissao:        dadosExtraidos.receitas?.transmissao ?? existingRow?.rec_transmissao,
      rec_bilheteria:         dadosExtraidos.receitas?.bilheteria ?? existingRow?.rec_bilheteria,
      rec_registros:          dadosExtraidos.receitas?.registros ?? existingRow?.rec_registros,
      rec_desenvolvimento:    dadosExtraidos.receitas?.desenvolvimento ?? existingRow?.rec_desenvolvimento,
      rec_academy:            dadosExtraidos.receitas?.academy ?? existingRow?.rec_academy,
      rec_financeiras:        dadosExtraidos.resultado_financeiro?.receitas_financeiras ?? existingRow?.rec_financeiras,

      // Custos futebol
      custo_selecao_principal: dadosExtraidos.custos_futebol?.selecao_principal ?? existingRow?.custo_selecao_principal,
      custo_selecao_base:      dadosExtraidos.custos_futebol?.selecoes_base ?? existingRow?.custo_selecao_base,
      custo_selecao_femininas: dadosExtraidos.custos_futebol?.selecoes_femininas ?? existingRow?.custo_selecao_femininas,
      custo_fomento:           dadosExtraidos.custos_futebol?.fomento ?? existingRow?.custo_fomento,

      // Despesas operacionais
      desp_pessoal:           dadosExtraidos.despesas?.pessoal ?? existingRow?.desp_pessoal,
      desp_administrativas:   dadosExtraidos.despesas?.administrativas ?? existingRow?.desp_administrativas,
      desp_impostos_taxas:    dadosExtraidos.despesas?.impostos_taxas ?? existingRow?.desp_impostos_taxas,

      // Resultado financeiro
      res_fin_receitas:       dadosExtraidos.resultado_financeiro?.receitas_financeiras ?? existingRow?.res_fin_receitas,
      res_fin_despesas:       dadosExtraidos.resultado_financeiro?.despesas_financeiras ?? existingRow?.res_fin_despesas,
      res_fin_cambial:        dadosExtraidos.resultado_financeiro?.variacao_cambial ?? existingRow?.res_fin_cambial,

      // Balanço
      ativo_total:            dadosExtraidos.balanco?.ativo_total ?? existingRow?.ativo_total,
      ativo_circulante:       dadosExtraidos.balanco?.ativo_circulante ?? existingRow?.ativo_circulante,
      caixa_equivalentes:     dadosExtraidos.balanco?.caixa_equivalentes ?? existingRow?.caixa_equivalentes,
      contas_receber:         dadosExtraidos.balanco?.contas_receber ?? existingRow?.contas_receber,
      tributos_recuperar:     dadosExtraidos.balanco?.tributos_recuperar ?? existingRow?.tributos_recuperar,
      depositos_judiciais:    dadosExtraidos.balanco?.depositos_judiciais ?? existingRow?.depositos_judiciais,
      imobilizado:            dadosExtraidos.balanco?.imobilizado ?? existingRow?.imobilizado,
      passivo_circulante:     dadosExtraidos.balanco?.passivo_circulante ?? existingRow?.passivo_circulante,
      receitas_diferidas_cp:  dadosExtraidos.balanco?.receitas_diferidas_cp ?? existingRow?.receitas_diferidas_cp,
      receitas_diferidas_lp:  dadosExtraidos.balanco?.receitas_diferidas_lp ?? existingRow?.receitas_diferidas_lp,
      prov_contingencias:     dadosExtraidos.balanco?.prov_contingencias ?? existingRow?.prov_contingencias,
      patrimonio_liquido:     dadosExtraidos.balanco?.patrimonio_liquido ?? existingRow?.patrimonio_liquido,
      patrimonio_social:      dadosExtraidos.balanco?.patrimonio_social ?? existingRow?.patrimonio_social,

      // DFC
      fluxo_operacional:      dadosExtraidos.dfc?.fluxo_operacional ?? existingRow?.fluxo_operacional,
      fluxo_investimento:     dadosExtraidos.dfc?.fluxo_investimento ?? existingRow?.fluxo_investimento,
      variacao_caixa:         dadosExtraidos.dfc?.variacao_total ?? existingRow?.variacao_caixa,

      // JSON completo mesclado
      dados_raw: mergedRaw,
      updated_at: new Date().toISOString()
    }

    const { error: upsertError } = await supabase
      .from(t("dados_financeiros"))
      .upsert(novosDados, { onConflict: "periodo" })

    if (upsertError) {
      throw new Error(`Erro ao salvar dados: ${upsertError.message}`)
    }

    // ── 5.5. Gerar insights analíticos com IA ──
    // Verificar se o OUTRO arquivo também já foi processado para este período
    const sources = mergedRaw._sources || {}
    const hasDfs = !!sources.dfs
    const hasBalancete = !!sources.balancete
    const bothFilesAvailable = hasDfs && hasBalancete

    console.log(`Gerando insights analíticos... (DFS: ${hasDfs}, Balancete: ${hasBalancete})`)

    // Buscar dados do período anterior para comparações
    const { data: dadosAnteriores } = await supabase
      .from(t("dados_financeiros"))
      .select("*")
      .neq("periodo", periodo)
      .order("periodo", { ascending: false })
      .limit(1)

    // Preparar texto dos arquivos para Claude insights
    let insightFilesText = `## ARQUIVO ATUAL: ${filename}\n\n${sheetText}`

    // Se o outro arquivo existe, baixar e incluir
    let otherFileLabel = ''
    if (bothFilesAvailable) {
      const otherTipo = tipo_documento === 'dfs' ? 'balancete' : 'dfs'
      const { data: otherUpload } = await supabase
        .from(t("uploads"))
        .select("storage_path, filename")
        .eq("periodo", periodo)
        .eq("tipo_documento", otherTipo)
        .eq("status", "done")
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .single()

      if (otherUpload) {
        try {
          const { data: otherFile } = await supabase.storage
            .from("uploads-cbf")
            .download(otherUpload.storage_path)
          if (otherFile) {
            const otherBuffer = await otherFile.arrayBuffer()
            const otherWb = XLSX.read(new Uint8Array(otherBuffer), { type: "array" })
            const otherText = xlsxToText(otherWb)
            insightFilesText += `\n\n## ARQUIVO COMPLEMENTAR: ${otherUpload.filename} (${otherTipo})\n\n${otherText}`
            otherFileLabel = ` + ${otherUpload.filename} (${otherTipo})`
            console.log(`Incluindo segundo arquivo para insights: ${otherUpload.filename}`)
          }
        } catch (e: any) {
          console.warn("Não foi possível incluir o outro arquivo:", e.message)
        }
      }
    }

    const insightsPrompt = buildInsightsPrompt(
      mergedRaw, dadosAnteriores?.[0] || null, periodo,
      filename + otherFileLabel, bothFilesAvailable
    )

    try {
      const insightsResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 12000,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: `${insightFilesText}\n\n---\n\n${insightsPrompt}` }
            ]
          }]
        })
      })

      if (insightsResponse.ok) {
        const insightsData = await insightsResponse.json()
        const insightsText = insightsData.content?.[0]?.text || ""

        const insightsMatch = insightsText.match(/```json\n?([\s\S]*?)\n?```/) ||
                              insightsText.match(/\{[\s\S]*\}/)

        if (insightsMatch) {
          const insightsJSON = JSON.parse(insightsMatch[1] || insightsMatch[0])

          const { error: insightError } = await supabase
            .from(t("insights_gerados"))
            .upsert({
              periodo,
              upload_id,
              conteudo: insightsJSON,
              updated_at: new Date().toISOString()
            }, { onConflict: "periodo" })

          if (insightError) {
            console.error("Erro ao salvar insights:", insightError.message)
          } else {
            console.log("✅ Insights gerados e salvos com sucesso")
          }
        } else {
          console.warn("Claude não retornou JSON válido para insights")
        }
      } else {
        console.error("Erro na API Claude (insights):", await insightsResponse.text())
      }
    } catch (insightErr: any) {
      console.error("Erro ao gerar insights (não bloqueante):", insightErr.message)
    }

    // ── 6. Atualizar período atual na config ──
    await supabase
      .from(t("configuracao"))
      .upsert({ chave: "periodo_atual", valor: periodo, updated_at: new Date().toISOString() })

    // ── 7. Marcar upload como concluído ──
    await supabase
      .from(t("uploads"))
      .update({ status: "done", processed_at: new Date().toISOString() })
      .eq("id", upload_id)

    // ── 8. Disparar rebuild no Vercel ──
    const vercelHook = Deno.env.get("VERCEL_DEPLOY_HOOK")
    if (vercelHook) {
      await fetch(vercelHook, { method: "POST" })
      console.log("Vercel rebuild disparado")
    }

    console.log(`✅ Processamento concluído para ${periodo}`)
    return new Response(JSON.stringify({ ok: true, periodo }), {
      headers: { "Content-Type": "application/json" }
    })

  } catch (err: any) {
    console.error("Erro no processamento:", err)

    // Marcar upload como erro se tiver upload_id
    try {
      const body = await req.clone().json()
      if (body.upload_id) {
        const table = body.env === 'dev' ? 'dev_uploads' : 'uploads'
        await supabase
          .from(table)
          .update({ status: "error", error_msg: err.message })
          .eq("id", body.upload_id)
      }
    } catch {}

    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })
  }
})

// ── Converter workbook xlsx para texto legível ──
function xlsxToText(workbook: XLSX.WorkBook): string {
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", blankrows: false })
    if (csv.trim().length === 0) continue
    parts.push(`### Aba: ${name}\n${csv}`)
  }
  return parts.join("\n\n")
}

// ── Converter valores de reais para R$ milhares (dividir por 1000) ──
// Campos que NÃO devem ser convertidos (strings, metadados)
const SKIP_KEYS = new Set(["periodo", "fonte", "tipo", "nome", "descricao", "conta"])
function convertToThousands(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "number") return Math.round(obj / 1000)
  if (typeof obj === "string") return obj
  if (Array.isArray(obj)) return obj.map(item => convertToThousands(item))
  if (typeof obj === "object") {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      if (SKIP_KEYS.has(key) || typeof value === "string") {
        result[key] = value
      } else {
        result[key] = convertToThousands(value)
      }
    }
    return result
  }
  return obj
}

// ── Prompt para o Claude extrair os dados ──
function buildPrompt(periodo: string, filename: string): string {
  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

Extraia TODOS os dados numéricos das seguintes abas: BP, DRE, DFC, e Notas 12, 13, 14 e 15.
Os valores estão em R$ milhares.

Retorne APENAS um JSON válido no seguinte formato (sem texto antes ou depois, sem markdown exceto o bloco json):

\`\`\`json
{
  "periodo": "${periodo}",
  "fonte": "${filename}",
  "dre": {
    "receita_bruta": 0,
    "deducoes": 0,
    "receita_liquida": 0,
    "custos_futebol": 0,
    "superavit_bruto": 0,
    "despesas_operacionais": 0,
    "resultado_financeiro": 0,
    "outras_receitas": 0,
    "resultado_antes_ir": 0,
    "ir_csll": 0,
    "resultado_exercicio": 0
  },
  "receitas": {
    "patrocinio": 0,
    "transmissao": 0,
    "bilheteria": 0,
    "registros": 0,
    "desenvolvimento": 0,
    "academy": 0,
    "legado": 0
  },
  "custos_futebol": {
    "selecao_principal": 0,
    "selecoes_base": 0,
    "selecoes_femininas": 0,
    "fomento": 0
  },
  "despesas": {
    "pessoal": 0,
    "administrativas": 0,
    "impostos_taxas": 0
  },
  "resultado_financeiro": {
    "receitas_financeiras": 0,
    "despesas_financeiras": 0,
    "variacao_cambial": 0,
    "total": 0
  },
  "balanco": {
    "ativo_total": 0,
    "ativo_circulante": 0,
    "caixa_equivalentes": 0,
    "contas_receber": 0,
    "tributos_recuperar": 0,
    "adiantamentos": 0,
    "depositos_judiciais": 0,
    "imobilizado": 0,
    "intangivel": 0,
    "passivo_circulante": 0,
    "fornecedores": 0,
    "receitas_diferidas_cp": 0,
    "obrig_trabalhistas": 0,
    "receitas_diferidas_lp": 0,
    "prov_contingencias": 0,
    "patrimonio_social": 0,
    "resultado_acumulado": 0,
    "patrimonio_liquido": 0
  },
  "dfc": {
    "resultado_exercicio": 0,
    "ajustes_provisoes": 0,
    "depreciacao": 0,
    "variacao_ativos": 0,
    "variacao_passivos": 0,
    "fluxo_operacional": 0,
    "compra_imobilizado": 0,
    "fluxo_investimento": 0,
    "variacao_total": 0,
    "saldo_inicial": 0,
    "saldo_final": 0
  },
  "competicoes": [
    { "nome": "Brasileiro Série A", "valor_2025": 0, "valor_2024": 0 }
  ],
  "patrocinadores_destaque": {
    "saidas": [],
    "entradas_crescimentos": []
  }
}
\`\`\`

Use os valores exatos do arquivo. Se um campo não existir no arquivo, use null.
Para o campo "competicoes", liste todas as competições da Nota 13 com seus valores de 2025 e 2024.`
}

// ── Prompt para o Claude extrair dados do BALANCETE ──
function buildBalancetePrompt(periodo: string, filename: string): string {
  return `Você é um especialista em contabilidade e demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx de Balancete da CBF (arquivo: ${filename}, período: ${periodo}).

O Balancete contém contas contábeis com saldos acumulados do ano até o mês. Os valores estão em R$ (reais). Retorne os valores EXATOS como estão no arquivo, sem converter ou dividir.
Extraia os dados e mapeie para o formato padrão abaixo, agregando as contas conforme necessário:

- Receitas: identifique contas de receita (4.x) e classifique por categoria  
- Custos: identifique contas de custo/despesa (5.x, 6.x) e classifique
- Ativo/Passivo: identifique contas patrimoniais (1.x = ativo, 2.x = passivo, 3.x = PL)
- DFC: se disponível, extraia fluxos de caixa; caso contrário use null

Retorne APENAS um JSON válido no seguinte formato:

\`\`\`json
{
  "periodo": "${periodo}",
  "fonte": "${filename}",
  "tipo": "balancete",
  "dre": {
    "receita_bruta": 0,
    "deducoes": 0,
    "receita_liquida": 0,
    "custos_futebol": 0,
    "superavit_bruto": 0,
    "despesas_operacionais": 0,
    "resultado_financeiro": 0,
    "outras_receitas": 0,
    "resultado_antes_ir": 0,
    "ir_csll": 0,
    "resultado_exercicio": 0
  },
  "receitas": {
    "patrocinio": 0,
    "transmissao": 0,
    "bilheteria": 0,
    "registros": 0,
    "desenvolvimento": 0,
    "academy": 0,
    "legado": 0
  },
  "custos_futebol": {
    "selecao_principal": 0,
    "selecoes_base": 0,
    "selecoes_femininas": 0,
    "fomento": 0
  },
  "despesas": {
    "pessoal": 0,
    "administrativas": 0,
    "impostos_taxas": 0
  },
  "resultado_financeiro": {
    "receitas_financeiras": 0,
    "despesas_financeiras": 0,
    "variacao_cambial": 0,
    "total": 0
  },
  "balanco": {
    "ativo_total": 0,
    "ativo_circulante": 0,
    "caixa_equivalentes": 0,
    "contas_receber": 0,
    "tributos_recuperar": 0,
    "adiantamentos": 0,
    "depositos_judiciais": 0,
    "imobilizado": 0,
    "intangivel": 0,
    "passivo_circulante": 0,
    "fornecedores": 0,
    "receitas_diferidas_cp": 0,
    "obrig_trabalhistas": 0,
    "receitas_diferidas_lp": 0,
    "prov_contingencias": 0,
    "patrimonio_social": 0,
    "resultado_acumulado": 0,
    "patrimonio_liquido": 0
  },
  "dfc": {
    "resultado_exercicio": 0,
    "ajustes_provisoes": 0,
    "depreciacao": 0,
    "variacao_ativos": 0,
    "variacao_passivos": 0,
    "fluxo_operacional": 0,
    "compra_imobilizado": 0,
    "fluxo_investimento": 0,
    "variacao_total": 0,
    "saldo_inicial": 0,
    "saldo_final": 0
  },
  "contas_detalhadas": {
    "receitas_por_conta": [
      { "conta": "4.1.01.01", "descricao": "descricao", "saldo": 0 }
    ],
    "custos_por_conta": [
      { "conta": "5.1.01.01", "descricao": "descricao", "saldo": 0 }
    ],
    "despesas_por_conta": [
      { "conta": "6.1.01.01", "descricao": "descricao", "saldo": 0 }
    ]
  }
}
\`\`\`

Use os valores exatos do arquivo. Se um campo não existir ou não puder ser classificado, use null.
O campo "contas_detalhadas" deve conter as 20 maiores contas de cada categoria (receita, custo, despesa) com seus saldos.
Agrupe contas que claramente pertencem à mesma categoria para os campos resumidos.`
}

// ── Prompt para gerar insights analíticos ──
function buildInsightsPrompt(dadosExtraidos: any, dadosAnteriores: any, periodo: string, filename: string, bothFiles: boolean): string {
  const anoAtual = periodo.split('-')[0]
  const anoAnterior = dadosAnteriores ? dadosAnteriores.periodo?.split('-')[0] || String(+anoAtual - 1) : String(+anoAtual - 1)

  const filesNote = bothFiles
    ? `\n## FONTES DISPONÍVEIS\nVocê recebeu AMBOS os documentos: Demonstrações Financeiras (DFs) e Balancete. Use os dois para cruzar dados, detalhar subcategorias e gerar insights mais ricos. O Balancete possui dados mais granulares por conta contábil; as DFs possuem demonstrações consolidadas com Notas Explicativas.\n`
    : `\n## FONTE DISPONÍVEL\nApenas um documento disponível (${filename}). Análise baseada nos dados disponíveis.\n`

  return `Você é um analista financeiro sênior especializado em demonstrações financeiras de entidades esportivas brasileiras.
Analise os dados das planilhas xlsx fornecidos acima, das Demonstrações Financeiras da CBF (período: ${periodo}), e os dados extraídos abaixo para gerar insights analíticos detalhados.
${filesNote}

## DADOS EXTRAÍDOS DO PERÍODO ATUAL (${periodo})
${JSON.stringify(dadosExtraidos, null, 2)}

${dadosAnteriores ? `## DADOS DO PERÍODO ANTERIOR (${dadosAnteriores.periodo})
${JSON.stringify(dadosAnteriores.dados_raw || dadosAnteriores, null, 2)}` : '## DADOS DO PERÍODO ANTERIOR\nNão disponível — use apenas os dados do período atual e do arquivo xlsx.'}

## INSTRUÇÕES
Gere insights analíticos para um dashboard financeiro executivo da CBF. Os textos devem ser:
- Profissionais, concisos e objetivos
- Em português brasileiro
- Com valores numéricos formatados (R$ X milhões, R$ X,XX bilhões)  
- Use tags HTML inline: <strong> para valores e destaques
- Baseados nos dados reais do arquivo xlsx e dos dados extraídos
- Comparem período atual vs anterior quando houver dados disponíveis

## REGRAS DE CONVENÇÃO CONTÁBIL
- Receita aumenta = BOM | Receita diminui = RUIM
- Custo/Despesa aumenta = RUIM | Custo/Despesa diminui = BOM
- Setas: ▲ para valor que subiu, ▼ para valor que desceu

## SEÇÕES DO DASHBOARD — Consulte as Notas Explicativas do xlsx para detalhar subcategorias

Retorne APENAS um JSON válido:

\`\`\`json
{
  "resumo_deficit": "Parágrafo analítico sobre o resultado do exercício (superávit ou déficit). Explicar as causas, o contexto operacional e a posição de caixa. Incluir valores de receita bruta, custos, caixa e receitas financeiras. Máximo 3-4 frases.",

  "receitas_destaque": "Parágrafo curto (2-3 frases) destacando as principais variações de receita entre períodos. Mencionar as maiores quedas e crescimentos por categoria.",

  "custos_selecao_principal": {
    "titulo": "SELEÇÃO PRINCIPAL +/−R$ XMi (variação total)",
    "texto": "Detalhamento por subcategoria extraído da Nota 13/14: ex. Serviços Contratados +R$ XMi, Pessoal +R$ XMi, Gerais −R$ XMi, etc."
  },
  "custos_selecao_base": {
    "titulo": "SELEÇÕES DE BASE +/−R$ XMi",
    "texto": "Detalhamento por subcategoria."
  },
  "custos_selecao_femininas": {
    "titulo": "SELEÇÕES FEMININAS +/−R$ XMi",
    "texto": "Detalhamento por subcategoria."
  },
  "custos_fomento": {
    "titulo": "CONTRIBUIÇÃO AO FOMENTO DO FUTEBOL +/−R$ XMi",
    "texto": "Detalhamento por subcategoria."
  },

  "custos_admin_alerta": "Parágrafo analítico sobre despesas administrativas: variação percentual, principais drivers (jurídico, PCLD, serviços, viagens), valores. 2-3 frases.",

  "balanco_ativo": "Composição do ativo: principais itens com valores e percentuais do ativo total. 2-3 frases.",
  "balanco_passivo": "Nota sobre passivo e PL: receitas diferidas, contingências, patrimônio. Variações relevantes. 2-3 frases.",
  "balanco_evolucao": "Evolução patrimonial: comparar ativo total entre períodos, destacar marcos (ex. adiantamento Nike). 2-3 frases.",

  "indicadores_ebitda": "Cálculo e análise do EBITDA/Margem EBITDA. Fórmula usada e interpretação. 2-3 frases.",
  "indicadores_kanitz": "Análise do Índice de Kanitz (solvência). Valor calculado e interpretação. 1-2 frases.",
  "indicadores_liquidez_corrente": "Liquidez Corrente: valor, comparação com anterior, interpretação. 1-2 frases.",
  "indicadores_liquidez_geral": "Liquidez Geral: valor, comparação com anterior, interpretação. 1-2 frases.",
  "indicadores_liquidez_imediata": "Liquidez Imediata: valor, comparação com anterior, interpretação. 1-2 frases.",
  "indicadores_dfc": "Análise da DFC: variação total do caixa, principais componentes operacional e investimento. 2-3 frases.",
  "indicadores_tendencia": "Tendência das disponibilidades ao longo dos anos. Principais marcos. 2-3 frases.",

  "historico_perspectiva": "Perspectiva para os próximos 1-2 anos considerando ciclo de competições (Copa do Mundo, novos contratos). 2-3 frases.",

  "nike_banner": "Texto curto sobre o contrato Nike: valor de antecipação, receita anual registrada no período, vigência. 1-2 frases.",

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

IMPORTANTE:
- Use os dados REAIS do arquivo xlsx e dos dados extraídos. Não invente valores.
- Para os detalhamentos de custos (custos_selecao_principal, etc.), consulte as Notas Explicativas 13 e 14 do xlsx para extrair as subcategorias.
- Todos os valores no xlsx estão em R$ milhares. Converta para milhões (divida por 1000) na apresentação.
- Se não houver dados do período anterior, faça análise apenas do período atual.
- Retorne APENAS o JSON, sem texto antes ou depois.`
}
