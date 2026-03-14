// supabase/functions/process-upload/index.ts
// Edge Function: ativada via webhook quando arquivo chega no Storage
// Lê o xlsx → envia para Claude API → salva JSON no banco

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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
    const { upload_id, storage_path, periodo, filename } = body

    console.log(`Processando upload: ${filename} | Período: ${periodo}`)

    // ── 1. Atualizar status para 'processing' ──
    await supabase
      .from("uploads")
      .update({ status: "processing" })
      .eq("id", upload_id)

    // ── 2. Baixar o arquivo do Storage ──
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("uploads-cbf")
      .download(storage_path)

    if (downloadError || !fileData) {
      throw new Error(`Erro ao baixar arquivo: ${downloadError?.message}`)
    }

    // Converter para base64 para enviar ao Claude
    const arrayBuffer = await fileData.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const base64 = btoa(String.fromCharCode(...bytes))

    // ── 3. Enviar para Claude API ──
    const prompt = buildPrompt(periodo, filename)

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                data: base64
              }
            },
            { type: "text", text: prompt }
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

    const dadosExtraidos = JSON.parse(jsonMatch[1] || jsonMatch[0])

    // ── 5. Salvar no banco ──
    const dadosParaSalvar = {
      periodo,
      upload_id,
      source_file: filename,

      // DRE
      receita_bruta:          dadosExtraidos.dre?.receita_bruta,
      receita_liquida:        dadosExtraidos.dre?.receita_liquida,
      custos_futebol:         dadosExtraidos.dre?.custos_futebol,
      superavit_bruto:        dadosExtraidos.dre?.superavit_bruto,
      despesas_operacionais:  dadosExtraidos.dre?.despesas_operacionais,
      resultado_financeiro:   dadosExtraidos.dre?.resultado_financeiro,
      resultado_exercicio:    dadosExtraidos.dre?.resultado_exercicio,

      // Receitas detalhadas
      rec_patrocinio:         dadosExtraidos.receitas?.patrocinio,
      rec_transmissao:        dadosExtraidos.receitas?.transmissao,
      rec_bilheteria:         dadosExtraidos.receitas?.bilheteria,
      rec_registros:          dadosExtraidos.receitas?.registros,
      rec_desenvolvimento:    dadosExtraidos.receitas?.desenvolvimento,
      rec_academy:            dadosExtraidos.receitas?.academy,
      rec_financeiras:        dadosExtraidos.resultado_financeiro?.receitas_financeiras,

      // Custos futebol
      custo_selecao_principal: dadosExtraidos.custos_futebol?.selecao_principal,
      custo_selecao_base:      dadosExtraidos.custos_futebol?.selecoes_base,
      custo_selecao_femininas: dadosExtraidos.custos_futebol?.selecoes_femininas,
      custo_fomento:           dadosExtraidos.custos_futebol?.fomento,

      // Despesas operacionais
      desp_pessoal:           dadosExtraidos.despesas?.pessoal,
      desp_administrativas:   dadosExtraidos.despesas?.administrativas,
      desp_impostos_taxas:    dadosExtraidos.despesas?.impostos_taxas,

      // Resultado financeiro
      res_fin_receitas:       dadosExtraidos.resultado_financeiro?.receitas_financeiras,
      res_fin_despesas:       dadosExtraidos.resultado_financeiro?.despesas_financeiras,
      res_fin_cambial:        dadosExtraidos.resultado_financeiro?.variacao_cambial,

      // Balanço
      ativo_total:            dadosExtraidos.balanco?.ativo_total,
      ativo_circulante:       dadosExtraidos.balanco?.ativo_circulante,
      caixa_equivalentes:     dadosExtraidos.balanco?.caixa_equivalentes,
      contas_receber:         dadosExtraidos.balanco?.contas_receber,
      tributos_recuperar:     dadosExtraidos.balanco?.tributos_recuperar,
      depositos_judiciais:    dadosExtraidos.balanco?.depositos_judiciais,
      imobilizado:            dadosExtraidos.balanco?.imobilizado,
      passivo_circulante:     dadosExtraidos.balanco?.passivo_circulante,
      receitas_diferidas_cp:  dadosExtraidos.balanco?.receitas_diferidas_cp,
      receitas_diferidas_lp:  dadosExtraidos.balanco?.receitas_diferidas_lp,
      prov_contingencias:     dadosExtraidos.balanco?.prov_contingencias,
      patrimonio_liquido:     dadosExtraidos.balanco?.patrimonio_liquido,
      patrimonio_social:      dadosExtraidos.balanco?.patrimonio_social,

      // DFC
      fluxo_operacional:      dadosExtraidos.dfc?.fluxo_operacional,
      fluxo_investimento:     dadosExtraidos.dfc?.fluxo_investimento,
      variacao_caixa:         dadosExtraidos.dfc?.variacao_total,

      // JSON completo para fallback
      dados_raw: dadosExtraidos,
      updated_at: new Date().toISOString()
    }

    const { error: upsertError } = await supabase
      .from("dados_financeiros")
      .upsert(dadosParaSalvar, { onConflict: "periodo" })

    if (upsertError) {
      throw new Error(`Erro ao salvar dados: ${upsertError.message}`)
    }

    // ── 6. Atualizar período atual na config ──
    await supabase
      .from("configuracao")
      .upsert({ chave: "periodo_atual", valor: periodo, updated_at: new Date().toISOString() })

    // ── 7. Marcar upload como concluído ──
    await supabase
      .from("uploads")
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
        await supabase
          .from("uploads")
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

// ── Prompt para o Claude extrair os dados ──
function buildPrompt(periodo: string, filename: string): string {
  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise este arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

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
