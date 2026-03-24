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

// Nomes possíveis da aba de balancete dentro da DFS
const BALANCETE_SHEET_NAMES = ["Balancete", "balancete", "BALANCETE", "Balanc", "100.Balancete"]

serve(async (req) => {
  let _uploadId = ''
  let _env = 'prod'
  try {
    const body = await req.json()
    const { upload_id, storage_path, periodo, filename, tipo_documento = 'dfs', env = 'prod' } = body
    _uploadId = upload_id
    _env = env
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

    // Detectar se a DFS contém uma aba de balancete embutida
    const balanceteSheetName = tipo_documento === 'dfs'
      ? workbook.SheetNames.find((n: string) => BALANCETE_SHEET_NAMES.some(b => n.toLowerCase().includes(b.toLowerCase())))
      : null
    const hasEmbeddedBalancete = !!balanceteSheetName

    if (hasEmbeddedBalancete) {
      console.log(`📋 Balancete embutido detectado na aba: "${balanceteSheetName}"`)
    }

    // DFS: priorizar abas relevantes (BP, DRE, DFC, notas) para não estourar o limite de chars
    // Se tem balancete embutido, incluir também a aba de balancete nas prioritárias
    const prioritySheets = hasEmbeddedBalancete
      ? [...ABAS_ALVO, balanceteSheetName!]
      : ABAS_ALVO

    const sheetText = tipo_documento === 'balancete'
      ? xlsxToText(workbook)
      : xlsxToText(workbook, prioritySheets)

    // ── 3. Enviar para Claude API com prompt adequado ao tipo ──
    // Se DFS tem balancete embutido, usar prompt híbrido que extrai ambos
    const prompt = tipo_documento === 'balancete'
      ? buildBalancetePrompt(periodo, filename)
      : hasEmbeddedBalancete
        ? buildHybridPrompt(periodo, filename, balanceteSheetName!)
        : buildPrompt(periodo, filename)

    const claudeCtrl = new AbortController()
    const claudeTimeout = setTimeout(() => claudeCtrl.abort(), 120_000)
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      signal: claudeCtrl.signal,
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
    clearTimeout(claudeTimeout)

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
    let dadosExtraidos = tipo_documento === 'balancete'
      ? convertToThousands(dadosExtraidosRaw)
      : dadosExtraidosRaw

    // ── 4.5. Validação pós-extração + correção automática ──
    const validacao1 = validateExtraction(dadosExtraidos, tipo_documento)

    if (validacao1.missing.length > 0) {
      console.log(`⚠️ Validação: ${validacao1.missing.length} campos faltando: ${validacao1.missing.join(', ')}`)

      // Re-prompt Claude para extrair campos faltantes
      const correctionPrompt = buildCorrectionPrompt(validacao1.missing, periodo, tipo_documento)

      try {
        const corrCtrl = new AbortController()
        const corrTimeout = setTimeout(() => corrCtrl.abort(), 60_000)
        const correctionResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          signal: corrCtrl.signal,
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: `## CONTEÚDO DO ARQUIVO XLSX\n\n${sheetText}\n\n---\n\n${correctionPrompt}` }
              ]
            }]
          })
        })
        clearTimeout(corrTimeout)

        if (correctionResponse.ok) {
          const corrData = await correctionResponse.json()
          const corrText = corrData.content?.[0]?.text || ""
          const corrMatch = corrText.match(/```json\n?([\s\S]*?)\n?```/) || corrText.match(/\{[\s\S]*\}/)

          if (corrMatch) {
            const corrections = JSON.parse(corrMatch[1] || corrMatch[0])
            const convertedCorrections = tipo_documento === 'balancete' ? convertToThousands(corrections) : corrections

            // Mesclar correções no dadosExtraidos
            dadosExtraidos = deepMerge(dadosExtraidos, convertedCorrections, 'incoming')
            console.log(`✅ Correção aplicada. Re-validando...`)

            // Re-validar após correção
            const validacao2 = validateExtraction(dadosExtraidos, tipo_documento)
            if (validacao2.missing.length > 0) {
              console.warn(`⚠️ Ainda faltam ${validacao2.missing.length} campos após correção: ${validacao2.missing.join(', ')}`)
            } else {
              console.log(`✅ Re-validação OK: todos os campos críticos extraídos`)
            }
            if (validacao2.warnings.length > 0) {
              console.warn(`ℹ️ Avisos: ${validacao2.warnings.join(', ')}`)
            }
          }
        }
      } catch (corrErr: any) {
        console.warn(`Erro na correção (não bloqueante): ${corrErr.message}`)
      }
    } else {
      console.log(`✅ Validação OK: todos os campos críticos extraídos`)
      if (validacao1.warnings.length > 0) {
        console.warn(`ℹ️ Avisos: ${validacao1.warnings.join(', ')}`)
      }
    }

    // ── 5. Salvar no banco (merge com dados existentes) ──
    // Buscar dados já existentes para este período (do outro arquivo)
    const { data: existingRow } = await supabase
      .from(t("dados_financeiros"))
      .select("*")
      .eq("periodo", periodo)
      .single()

    const existingRaw = existingRow?.dados_raw || {}

    // Merge: dados_raw combina ambas as fontes com deep merge inteligente
    // DFS tem prioridade sobre balancete para dados consolidados
    const mergePriority = tipo_documento === 'dfs' ? 'incoming' as const : 'existing' as const
    const mergedRaw = deepMerge(existingRaw, dadosExtraidos, mergePriority)
    mergedRaw._sources = {
      ...(existingRaw._sources || {}),
      [tipo_documento]: { filename, processed_at: new Date().toISOString() },
      ...(hasEmbeddedBalancete ? { balancete: { filename, processed_at: new Date().toISOString(), embedded: true } } : {})
    }

    // Helper: merge com prioridade baseada na fonte.
    // DFS é a fonte autoritativa para DRE/BP/DFC. Balancete só preenche nulls.
    // Se o documento atual é DFS, seus valores têm prioridade (a=DFS, b=existing).
    // Se o documento atual é balancete, os valores existentes (vindos do DFS) têm prioridade (a=balancete, b=existing/DFS).
    const isDfs = tipo_documento === 'dfs'
    const pick = (incoming: any, existing: any) => {
      // Se DFS está sendo processado agora, preferir DFS (incoming)
      if (isDfs) {
        if (incoming !== null && incoming !== undefined) return incoming
        return existing
      }
      // Se balancete está sendo processado, preferir existing (provavelmente DFS)
      if (existing !== null && existing !== undefined && existing !== 0) return existing
      if (incoming !== null && incoming !== undefined && incoming !== 0) return incoming
      return existing ?? incoming
    }

    // Construir objeto de dados: novos valores preenchem os que estavam null
    const novosDados = {
      periodo,
      upload_id,
      source_file: filename,

      // DRE
      receita_bruta:          pick(dadosExtraidos.dre?.receita_bruta, existingRow?.receita_bruta),
      receita_liquida:        pick(dadosExtraidos.dre?.receita_liquida, existingRow?.receita_liquida),
      custos_futebol:         pick(dadosExtraidos.dre?.custos_futebol, existingRow?.custos_futebol),
      superavit_bruto:        pick(dadosExtraidos.dre?.superavit_bruto, existingRow?.superavit_bruto),
      despesas_operacionais:  pick(dadosExtraidos.dre?.despesas_operacionais, existingRow?.despesas_operacionais),
      resultado_financeiro:   pick(dadosExtraidos.dre?.resultado_financeiro, existingRow?.resultado_financeiro),
      resultado_exercicio:    pick(dadosExtraidos.dre?.resultado_exercicio, existingRow?.resultado_exercicio),

      // Receitas detalhadas
      rec_patrocinio:         pick(dadosExtraidos.receitas?.patrocinio, existingRow?.rec_patrocinio),
      rec_transmissao:        pick(dadosExtraidos.receitas?.transmissao, existingRow?.rec_transmissao),
      rec_bilheteria:         pick(dadosExtraidos.receitas?.bilheteria, existingRow?.rec_bilheteria),
      rec_registros:          pick(dadosExtraidos.receitas?.registros, existingRow?.rec_registros),
      rec_desenvolvimento:    pick(dadosExtraidos.receitas?.desenvolvimento, existingRow?.rec_desenvolvimento),
      rec_academy:            pick(dadosExtraidos.receitas?.academy, existingRow?.rec_academy),
      rec_financeiras:        pick(dadosExtraidos.resultado_financeiro?.receitas_financeiras, existingRow?.rec_financeiras),

      // Custos futebol
      custo_selecao_principal: pick(dadosExtraidos.custos_futebol?.selecao_principal, existingRow?.custo_selecao_principal),
      custo_selecao_base:      pick(dadosExtraidos.custos_futebol?.selecoes_base, existingRow?.custo_selecao_base),
      custo_selecao_femininas: pick(dadosExtraidos.custos_futebol?.selecoes_femininas, existingRow?.custo_selecao_femininas),
      custo_fomento:           pick(dadosExtraidos.custos_futebol?.fomento, existingRow?.custo_fomento),

      // Despesas operacionais
      desp_pessoal:           pick(dadosExtraidos.despesas?.pessoal, existingRow?.desp_pessoal),
      desp_administrativas:   pick(dadosExtraidos.despesas?.administrativas, existingRow?.desp_administrativas),
      desp_impostos_taxas:    pick(dadosExtraidos.despesas?.impostos_taxas, existingRow?.desp_impostos_taxas),

      // Resultado financeiro
      res_fin_receitas:       pick(dadosExtraidos.resultado_financeiro?.receitas_financeiras, existingRow?.res_fin_receitas),
      res_fin_despesas:       pick(dadosExtraidos.resultado_financeiro?.despesas_financeiras, existingRow?.res_fin_despesas),
      res_fin_cambial:        pick(dadosExtraidos.resultado_financeiro?.variacao_cambial, existingRow?.res_fin_cambial),

      // Balanço
      ativo_total:            pick(dadosExtraidos.balanco?.ativo_total, existingRow?.ativo_total),
      ativo_circulante:       pick(dadosExtraidos.balanco?.ativo_circulante, existingRow?.ativo_circulante),
      caixa_equivalentes:     pick(dadosExtraidos.balanco?.caixa_equivalentes, existingRow?.caixa_equivalentes),
      contas_receber:         pick(dadosExtraidos.balanco?.contas_receber, existingRow?.contas_receber),
      tributos_recuperar:     pick(dadosExtraidos.balanco?.tributos_recuperar, existingRow?.tributos_recuperar),
      depositos_judiciais:    pick(dadosExtraidos.balanco?.depositos_judiciais, existingRow?.depositos_judiciais),
      imobilizado:            pick(dadosExtraidos.balanco?.imobilizado, existingRow?.imobilizado),
      passivo_circulante:     pick(dadosExtraidos.balanco?.passivo_circulante, existingRow?.passivo_circulante),
      receitas_diferidas_cp:  pick(dadosExtraidos.balanco?.receitas_diferidas_cp, existingRow?.receitas_diferidas_cp),
      receitas_diferidas_lp:  pick(dadosExtraidos.balanco?.receitas_diferidas_lp, existingRow?.receitas_diferidas_lp),
      prov_contingencias:     pick(dadosExtraidos.balanco?.prov_contingencias, existingRow?.prov_contingencias),
      patrimonio_liquido:     pick(dadosExtraidos.balanco?.patrimonio_liquido, existingRow?.patrimonio_liquido),
      patrimonio_social:      pick(dadosExtraidos.balanco?.patrimonio_social, existingRow?.patrimonio_social),
      fornecedores:           pick(dadosExtraidos.balanco?.fornecedores, existingRow?.fornecedores),
      obrig_trabalhistas:     pick(dadosExtraidos.balanco?.obrig_trabalhistas, existingRow?.obrig_trabalhistas),
      adiantamentos:          pick(dadosExtraidos.balanco?.adiantamentos, existingRow?.adiantamentos),
      intangivel:             pick(dadosExtraidos.balanco?.intangivel, existingRow?.intangivel),
      resultado_acumulado:    pick(dadosExtraidos.balanco?.resultado_acumulado, existingRow?.resultado_acumulado),
      despesas_antecipadas:   pick(dadosExtraidos.balanco?.despesas_antecipadas, existingRow?.despesas_antecipadas),
      contas_receber_lp:      pick(dadosExtraidos.balanco?.contas_receber_lp, existingRow?.contas_receber_lp),
      investimentos:          pick(dadosExtraidos.balanco?.investimentos, existingRow?.investimentos),
      programas_desenvolvimento: pick(dadosExtraidos.balanco?.programas_desenvolvimento, existingRow?.programas_desenvolvimento),
      provisao_ferias:        pick(dadosExtraidos.balanco?.provisao_ferias, existingRow?.provisao_ferias),
      fornecedores_lp:        pick(dadosExtraidos.balanco?.fornecedores_lp, existingRow?.fornecedores_lp),

      // DRE complementar
      outras_receitas_op:     pick(dadosExtraidos.dre?.outras_receitas, existingRow?.outras_receitas_op),
      outras_despesas_op:     pick(dadosExtraidos.dre?.outras_despesas, existingRow?.outras_despesas_op),
      resultado_antes_ir:     pick(dadosExtraidos.dre?.resultado_antes_ir, existingRow?.resultado_antes_ir),
      ir_csll:                pick(dadosExtraidos.dre?.ir_csll, existingRow?.ir_csll),

      // DFC
      fluxo_operacional:      pick(dadosExtraidos.dfc?.fluxo_operacional, existingRow?.fluxo_operacional),
      fluxo_investimento:     pick(dadosExtraidos.dfc?.fluxo_investimento, existingRow?.fluxo_investimento),
      variacao_caixa:         pick(dadosExtraidos.dfc?.variacao_total, existingRow?.variacao_caixa),

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
    // Aguardar 65s para reset do rate limit (30k tokens/min compartilhado com extração)
    console.log("Aguardando reset do rate limit antes de gerar insights...")
    await new Promise(r => setTimeout(r, 65000))

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

    // Usar dados extraídos estruturados (JSON) em vez do xlsx raw para economizar tokens
    // Remover campos volumosos que não são necessários para insights narrativos
    const insightData = { ...mergedRaw }
    delete insightData.contas_detalhadas
    delete insightData.competicoes
    const insightDataText = `## DADOS FINANCEIROS EXTRAÍDOS: ${filename}\nPeríodo: ${periodo}\n\n\`\`\`json\n${JSON.stringify(insightData, null, 2)}\n\`\`\``

    const insightsPrompt = buildInsightsPrompt(
      mergedRaw, dadosAnteriores?.[0] || null, periodo,
      filename, bothFilesAvailable
    )

    let insightErrorMsg: string | null = null

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
          max_tokens: 8000,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: `${insightDataText}\n\n---\n\n${insightsPrompt}` }
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
            insightErrorMsg = `Insights save error: ${insightError.message}`
            console.error("Erro ao salvar insights:", insightError.message)
          } else {
            console.log("✅ Insights gerados e salvos com sucesso")
          }
        } else {
          insightErrorMsg = "Claude não retornou JSON válido para insights"
          console.warn(insightErrorMsg)
        }
      } else {
        const errBody = await insightsResponse.text()
        insightErrorMsg = `Insights API error: ${errBody.substring(0, 400)}`
        console.error("Erro na API Claude (insights):", errBody)
      }
    } catch (insightErr: any) {
      insightErrorMsg = `Insights exception: ${insightErr.message?.substring(0, 400)}`
      console.error("Erro ao gerar insights (não bloqueante):", insightErr.message)
    }

    // ── 6. Atualizar período atual na config ──
    await supabase
      .from(t("configuracao"))
      .upsert({ chave: "periodo_atual", valor: periodo, updated_at: new Date().toISOString() })

    // ── 7. Marcar upload como concluído ──
    await supabase
      .from(t("uploads"))
      .update({ status: "done", processed_at: new Date().toISOString(), error_msg: insightErrorMsg })
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

    // Marcar upload como erro
    if (_uploadId) {
      try {
        const table = _env === 'dev' ? 'dev_uploads' : 'uploads'
        await supabase
          .from(table)
          .update({ status: "error", error_msg: err.message?.substring(0, 500) })
          .eq("id", _uploadId)
      } catch (e) {
        console.error("Falha ao marcar erro:", e)
      }
    }

    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })
  }
})

// ── Deep merge: preserva valores de ambas as fontes. DFS tem prioridade sobre balancete. ──
// O parâmetro sourcePriority controla qual fonte é preferida:
// 'incoming' = novo documento tem prioridade (DFS processado agora)
// 'existing' = dados existentes têm prioridade (DFS já processado antes, balancete chegando)
function deepMerge(existing: any, incoming: any, sourcePriority: 'incoming' | 'existing' = 'incoming'): any {
  if (incoming === null || incoming === undefined) return existing
  if (existing === null || existing === undefined) return incoming
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    if (sourcePriority === 'incoming') {
      // Preferir incoming (DFS), exceto se null/undefined
      return (incoming !== null && incoming !== undefined) ? incoming : existing
    } else {
      // Preferir existing (DFS já no banco), usar incoming só se existing é null/0
      if (existing !== null && existing !== undefined && existing !== 0) return existing
      return (incoming !== null && incoming !== undefined && incoming !== 0) ? incoming : existing
    }
  }
  const result: any = { ...existing }
  for (const [key, val] of Object.entries(incoming)) {
    if (key === '_sources') continue
    result[key] = deepMerge(existing[key], val, sourcePriority)
  }
  return result
}

// ── Converter workbook xlsx para texto legível (otimizado para limites de token) ──
const MAX_CHARS = 80000 // ~20k tokens
function xlsxToText(workbook: XLSX.WorkBook, prioritySheets?: string[]): string {
  const parts: string[] = []
  let totalChars = 0

  // Ordenar abas: priorizar as relevantes (BP, DRE, DFC, notas) para não desperdiçar budget
  const ordered: string[] = []
  if (prioritySheets && prioritySheets.length > 0) {
    for (const prio of prioritySheets) {
      const lower = prio.toLowerCase()
      for (const name of workbook.SheetNames) {
        if (!ordered.includes(name) && (name === prio || name.toLowerCase() === lower)) {
          ordered.push(name)
        }
      }
    }
  }
  // Adicionar abas restantes depois das prioritárias
  for (const name of workbook.SheetNames) {
    if (!ordered.includes(name)) ordered.push(name)
  }

  for (const name of ordered) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", blankrows: false })
    if (csv.trim().length === 0) continue
    // Truncar abas muito grandes (manter primeiras 500 linhas)
    const lines = csv.split("\n")
    const truncated = lines.length > 500 ? lines.slice(0, 500).join("\n") + "\n[... truncado]" : csv
    if (totalChars + truncated.length > MAX_CHARS) {
      parts.push(`### Aba: ${name}\n[Aba omitida - limite de caracteres atingido]`)
      continue  // continuar tentando abas menores em vez de parar
    }
    parts.push(`### Aba: ${name}\n${truncated}`)
    totalChars += truncated.length
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
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}` // ex: 01/2026

  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

Extraia TODOS os dados numéricos das seguintes abas: BP, DRE, DFC, e Notas 12, 13, 14 e 15.
Os valores estão em R$ milhares.

## IMPORTANTE — COLUNAS
O arquivo tem MÚLTIPLAS colunas de datas. Use SEMPRE a PRIMEIRA coluna numérica após "Nota" (que corresponde ao período ${dataRef}).
- Na aba DRE: use a coluna "1/31/26" ou a primeira coluna de dados (período corrente)
- Na aba BP: use a coluna "1/31/26" ou a primeira coluna de dados (período corrente)
- Na aba DFC: a primeira coluna (pode estar rotulada "${ano}" ou "${+ano - 1}") corresponde ao período corrente

## RESULTADO FINANCEIRO
Na DRE, a seção "Resultado Financeiro" fica ENTRE "Total das despesas operacionais" e "Outros Resultados Operacionais". Contém:
- Receitas Financeiras (linha ~27)
- Despesas Financeiras (linha ~28)
- Variação Cambial (linha ~29)
- Total do Resultado Financeiro (linha ~30)
NÃO retorne null para estes campos — eles EXISTEM na DRE.

## PATRIMÔNIO
Na aba BP, o lado direito tem o Passivo e PL. "Patrimônio Social" está na seção "Patrimônio Líquido".

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
    "outras_despesas": 0,
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
    "despesas_antecipadas": 0,
    "contas_receber_lp": 0,
    "depositos_judiciais": 0,
    "investimentos": 0,
    "imobilizado": 0,
    "intangivel": 0,
    "passivo_circulante": 0,
    "fornecedores": 0,
    "programas_desenvolvimento": 0,
    "obrig_trabalhistas": 0,
    "provisao_ferias": 0,
    "receitas_diferidas_cp": 0,
    "receitas_diferidas_lp": 0,
    "fornecedores_lp": 0,
    "prov_contingencias": 0,
    "patrimonio_social": 0,
    "resultado_acumulado": 0,
    "patrimonio_liquido": 0
  },
  "dfc": {
    "resultado_exercicio": 0,
    "ajustes_operacionais": {
      "provisoes_contingentes": 0,
      "variacao_cambial": 0,
      "demais_provisoes_ajustes": 0,
      "depreciacao_amortizacao": 0
    },
    "superavit_bruto_antes_capital_giro": 0,
    "variacao_ativos": {
      "contas_receber": 0,
      "adto_fornecedores": 0,
      "despesas_antecipadas": 0,
      "impostos_recuperar": 0,
      "depositos_judiciais": 0,
      "total": 0
    },
    "variacao_passivos": {
      "fornecedores_contas_pagar": 0,
      "tributos_encargos": 0,
      "adto_transmissao_patrocinio": 0,
      "receita_diferida": 0,
      "ir_csll": 0,
      "total": 0
    },
    "fluxo_operacional": 0,
    "investimento": {
      "compra_imobilizado": 0,
      "baixa_imobilizado": 0
    },
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

// ── Prompt híbrido: DFS com balancete embutido ──
function buildHybridPrompt(periodo: string, filename: string, balanceteSheetName: string): string {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`

  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

Este arquivo contém TANTO as Demonstrações Financeiras (BP, DRE, DFC, Notas) QUANTO uma aba de Balancete ("${balanceteSheetName}").

## INSTRUÇÕES DE EXTRAÇÃO

### Das abas de DFs (BP, DRE, DFC, Notas 12-15):
- Use SEMPRE a PRIMEIRA coluna numérica (período ${dataRef})
- Valores em R$ milhares
- Extraia DRE, receitas, custos, despesas, resultado financeiro, balanço e DFC

### Da aba de Balancete ("${balanceteSheetName}"):
- O balancete contém contas contábeis com saldos acumulados
- Os valores do balancete estão em R$ (reais) — DIVIDA por 1000 para padronizar em R$ milhares
- Extraia as 20 maiores contas de cada categoria para "contas_detalhadas"
- Mapeie: 4.x = receitas, 5.x/6.x = custos/despesas, 1.x = ativo, 2.x = passivo, 3.x = PL

### Prioridade de dados:
- Para campos consolidados (DRE, balanço, DFC): use os valores das DFs (são mais confiáveis)
- Para "contas_detalhadas": use exclusivamente os dados do Balancete
- O balancete serve para DETALHAR e COMPLEMENTAR, não para substituir as DFs

## RESULTADO FINANCEIRO
Na DRE, a seção "Resultado Financeiro" fica ENTRE "Total das despesas operacionais" e "Outros Resultados Operacionais".

## PATRIMÔNIO
Na aba BP, "Patrimônio Social" está na seção "Patrimônio Líquido".

Retorne APENAS um JSON válido:

\`\`\`json
{
  "periodo": "${periodo}",
  "fonte": "${filename}",
  "dre": {
    "receita_bruta": 0, "deducoes": 0, "receita_liquida": 0, "custos_futebol": 0,
    "superavit_bruto": 0, "despesas_operacionais": 0, "resultado_financeiro": 0,
    "outras_receitas": 0, "outras_despesas": 0, "resultado_antes_ir": 0,
    "ir_csll": 0, "resultado_exercicio": 0
  },
  "receitas": {
    "patrocinio": 0, "transmissao": 0, "bilheteria": 0, "registros": 0,
    "desenvolvimento": 0, "academy": 0, "legado": 0
  },
  "custos_futebol": {
    "selecao_principal": 0, "selecoes_base": 0, "selecoes_femininas": 0, "fomento": 0
  },
  "despesas": { "pessoal": 0, "administrativas": 0, "impostos_taxas": 0 },
  "resultado_financeiro": {
    "receitas_financeiras": 0, "despesas_financeiras": 0, "variacao_cambial": 0, "total": 0
  },
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0,
    "contas_receber_lp": 0, "depositos_judiciais": 0, "investimentos": 0,
    "imobilizado": 0, "intangivel": 0, "passivo_circulante": 0, "fornecedores": 0,
    "programas_desenvolvimento": 0, "obrig_trabalhistas": 0, "provisao_ferias": 0,
    "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0,
    "patrimonio_liquido": 0
  },
  "dfc": {
    "resultado_exercicio": 0,
    "ajustes_operacionais": { "provisoes_contingentes": 0, "variacao_cambial": 0, "demais_provisoes_ajustes": 0, "depreciacao_amortizacao": 0 },
    "superavit_bruto_antes_capital_giro": 0,
    "variacao_ativos": { "contas_receber": 0, "adto_fornecedores": 0, "despesas_antecipadas": 0, "impostos_recuperar": 0, "depositos_judiciais": 0, "total": 0 },
    "variacao_passivos": { "fornecedores_contas_pagar": 0, "tributos_encargos": 0, "adto_transmissao_patrocinio": 0, "receita_diferida": 0, "ir_csll": 0, "total": 0 },
    "fluxo_operacional": 0,
    "investimento": { "compra_imobilizado": 0, "baixa_imobilizado": 0 },
    "fluxo_investimento": 0, "variacao_total": 0, "saldo_inicial": 0, "saldo_final": 0
  },
  "competicoes": [
    { "nome": "Brasileiro Série A", "valor_2025": 0, "valor_2024": 0 }
  ],
  "contas_detalhadas": {
    "receitas_por_conta": [ { "conta": "4.1.01.01", "descricao": "descricao", "saldo": 0 } ],
    "custos_por_conta": [ { "conta": "5.1.01.01", "descricao": "descricao", "saldo": 0 } ],
    "despesas_por_conta": [ { "conta": "6.1.01.01", "descricao": "descricao", "saldo": 0 } ]
  }
}
\`\`\`

Use os valores exatos do arquivo. Se um campo não existir, use null.
Para "competicoes", liste todas as competições da Nota 13.
Para "contas_detalhadas", extraia do Balancete as 20 maiores contas de cada categoria com saldos convertidos para R$ milhares (dividido por 1000).`
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
    "outras_despesas": 0,
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
    "despesas_antecipadas": 0,
    "contas_receber_lp": 0,
    "depositos_judiciais": 0,
    "investimentos": 0,
    "imobilizado": 0,
    "intangivel": 0,
    "passivo_circulante": 0,
    "fornecedores": 0,
    "programas_desenvolvimento": 0,
    "obrig_trabalhistas": 0,
    "provisao_ferias": 0,
    "receitas_diferidas_cp": 0,
    "receitas_diferidas_lp": 0,
    "fornecedores_lp": 0,
    "prov_contingencias": 0,
    "patrimonio_social": 0,
    "resultado_acumulado": 0,
    "patrimonio_liquido": 0
  },
  "dfc": {
    "resultado_exercicio": 0,
    "ajustes_operacionais": {
      "provisoes_contingentes": 0,
      "variacao_cambial": 0,
      "demais_provisoes_ajustes": 0,
      "depreciacao_amortizacao": 0
    },
    "superavit_bruto_antes_capital_giro": 0,
    "variacao_ativos": {
      "contas_receber": 0,
      "adto_fornecedores": 0,
      "despesas_antecipadas": 0,
      "impostos_recuperar": 0,
      "depositos_judiciais": 0,
      "total": 0
    },
    "variacao_passivos": {
      "fornecedores_contas_pagar": 0,
      "tributos_encargos": 0,
      "adto_transmissao_patrocinio": 0,
      "receita_diferida": 0,
      "ir_csll": 0,
      "total": 0
    },
    "fluxo_operacional": 0,
    "investimento": {
      "compra_imobilizado": 0,
      "baixa_imobilizado": 0
    },
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

// ── Validação pós-extração: verifica se todos os campos esperados foram extraídos ──
function validateExtraction(dados: any, tipo: string): { missing: string[]; warnings: string[] } {
  const missing: string[] = []
  const warnings: string[] = []

  // Campos críticos que DEVEM existir e ser numéricos (não null)
  const requiredFields: Record<string, string[]> = {
    dre: ['receita_bruta', 'deducoes', 'receita_liquida', 'custos_futebol', 'superavit_bruto',
          'despesas_operacionais', 'resultado_financeiro', 'outras_receitas', 'outras_despesas',
          'resultado_antes_ir', 'ir_csll', 'resultado_exercicio'],
    receitas: ['patrocinio', 'transmissao', 'bilheteria', 'registros', 'desenvolvimento'],
    custos_futebol: ['selecao_principal', 'selecoes_base', 'selecoes_femininas', 'fomento'],
    despesas: ['pessoal', 'administrativas', 'impostos_taxas'],
    resultado_financeiro: ['receitas_financeiras', 'despesas_financeiras', 'total'],
    balanco: [
      'ativo_total', 'ativo_circulante', 'caixa_equivalentes', 'contas_receber',
      'tributos_recuperar', 'adiantamentos', 'despesas_antecipadas',
      'contas_receber_lp', 'depositos_judiciais', 'investimentos', 'imobilizado', 'intangivel',
      'passivo_circulante', 'fornecedores', 'programas_desenvolvimento',
      'obrig_trabalhistas', 'provisao_ferias', 'receitas_diferidas_cp',
      'receitas_diferidas_lp', 'fornecedores_lp', 'prov_contingencias',
      'patrimonio_social', 'resultado_acumulado', 'patrimonio_liquido'
    ]
  }

  // DFC só é obrigatório para DFS (balancete geralmente não tem)
  if (tipo === 'dfs') {
    requiredFields.dfc = ['fluxo_operacional', 'fluxo_investimento', 'variacao_total']
  }

  for (const [section, fields] of Object.entries(requiredFields)) {
    if (!dados[section]) {
      missing.push(`${section} (seção inteira ausente)`)
      continue
    }
    for (const field of fields) {
      const val = dados[section][field]
      if (val === null || val === undefined) {
        missing.push(`${section}.${field}`)
      }
    }
  }

  // Verificações de consistência contábil
  if (dados.balanco) {
    const b = dados.balanco
    // Ativo total deve ser > 0
    if (b.ativo_total !== null && b.ativo_total !== undefined && b.ativo_total <= 0) {
      warnings.push(`balanco.ativo_total = ${b.ativo_total} (esperado > 0)`)
    }
    // Ativo circulante <= Ativo total
    if (b.ativo_total && b.ativo_circulante && b.ativo_circulante > b.ativo_total) {
      warnings.push(`ativo_circulante (${b.ativo_circulante}) > ativo_total (${b.ativo_total})`)
    }
    // Passivo circulante <= Ativo total (sanity check)
    if (b.ativo_total && b.passivo_circulante && b.passivo_circulante > b.ativo_total * 2) {
      warnings.push(`passivo_circulante (${b.passivo_circulante}) muito alto vs ativo_total (${b.ativo_total})`)
    }
  }

  // DRE: receita_bruta deve ser >= receita_liquida
  if (dados.dre?.receita_bruta && dados.dre?.receita_liquida) {
    if (dados.dre.receita_liquida > dados.dre.receita_bruta * 1.05) {
      warnings.push(`receita_liquida (${dados.dre.receita_liquida}) > receita_bruta (${dados.dre.receita_bruta})`)
    }
  }

  // DRE: verificar se soma das receitas detalhadas ≈ receita_bruta
  if (dados.receitas && dados.dre?.receita_bruta) {
    const r = dados.receitas
    const somaReceitas = (r.patrocinio || 0) + (r.transmissao || 0) + (r.bilheteria || 0) +
      (r.registros || 0) + (r.desenvolvimento || 0) + (r.academy || 0) + (r.legado || 0)
    if (somaReceitas > 0 && Math.abs(somaReceitas - dados.dre.receita_bruta) > dados.dre.receita_bruta * 0.15) {
      warnings.push(`soma receitas detalhadas (${somaReceitas}) difere muito da receita_bruta (${dados.dre.receita_bruta})`)
    }
  }

  // DRE: verificar se soma dos custos detalhados ≈ custos_futebol
  if (dados.custos_futebol && dados.dre?.custos_futebol) {
    const c = dados.custos_futebol
    const somaCustos = (c.selecao_principal || 0) + (c.selecoes_base || 0) +
      (c.selecoes_femininas || 0) + (c.fomento || 0)
    if (somaCustos > 0 && Math.abs(somaCustos - Math.abs(dados.dre.custos_futebol)) > Math.abs(dados.dre.custos_futebol) * 0.15) {
      warnings.push(`soma custos detalhados (${somaCustos}) difere muito dos custos_futebol DRE (${dados.dre.custos_futebol})`)
    }
  }

  // DRE: verificar se soma das despesas detalhadas ≈ despesas_operacionais
  if (dados.despesas && dados.dre?.despesas_operacionais) {
    const d = dados.despesas
    const somaDespesas = (d.pessoal || 0) + (d.administrativas || 0) + (d.impostos_taxas || 0)
    if (somaDespesas > 0 && Math.abs(somaDespesas - Math.abs(dados.dre.despesas_operacionais)) > Math.abs(dados.dre.despesas_operacionais) * 0.15) {
      warnings.push(`soma despesas detalhadas (${somaDespesas}) difere muito das despesas_operacionais DRE (${dados.dre.despesas_operacionais})`)
    }
  }

  // DRE: superavit_bruto ≈ receita_liquida - custos_futebol
  if (dados.dre?.receita_liquida && dados.dre?.custos_futebol && dados.dre?.superavit_bruto) {
    const esperado = dados.dre.receita_liquida + dados.dre.custos_futebol // custos é negativo
    if (Math.abs(esperado - dados.dre.superavit_bruto) > Math.abs(dados.dre.superavit_bruto) * 0.10) {
      warnings.push(`superavit_bruto (${dados.dre.superavit_bruto}) ≠ receita_liquida + custos (${esperado})`)
    }
  }

  // DRE: resultado_financeiro ≈ receitas_fin - despesas_fin + cambial
  if (dados.resultado_financeiro?.total && dados.resultado_financeiro?.receitas_financeiras) {
    const rf = dados.resultado_financeiro
    const calcRF = (rf.receitas_financeiras || 0) + (rf.despesas_financeiras || 0) + (rf.variacao_cambial || 0)
    if (Math.abs(calcRF - rf.total) > Math.abs(rf.total) * 0.15) {
      warnings.push(`resultado_financeiro.total (${rf.total}) ≠ soma componentes (${calcRF})`)
    }
  }

  return { missing, warnings }
}

// ── Prompt de correção: pede ao Claude para extrair apenas campos faltantes ──
function buildCorrectionPrompt(missingFields: string[], periodo: string, tipo: string): string {
  const fieldsList = missingFields.map(f => `- ${f}`).join('\n')

  // Agrupar campos por seção para facilitar a resposta
  const sections = new Set(missingFields.map(f => f.split('.')[0].replace(/ \(.*\)/, '')))
  const sectionsList = [...sections].join(', ')

  return `Na extração anterior dos dados financeiros (${tipo}, período ${periodo}), os seguintes campos ficaram com valor null ou ausentes:

${fieldsList}

Revise CUIDADOSAMENTE o conteúdo do arquivo xlsx acima e extraia ESPECIFICAMENTE estes campos faltantes.
Procure nas abas relevantes: ${tipo === 'dfs' ? 'BP, DRE, DFC, e Notas 12-15' : 'todas as abas do balancete'}.

REGRAS:
- Use SEMPRE a PRIMEIRA coluna numérica (período corrente)
- Se o campo existe no arquivo mas com outro nome/posição, identifique-o pelo contexto contábil
- Se o campo realmente não existir no arquivo, retorne 0 (zero), NUNCA null
- Valores devem ser numéricos (em R$ milhares para DFS, R$ reais para balancete)

Retorne APENAS um JSON válido com as seções afetadas (${sectionsList}):

\`\`\`json
{
  "secao": {
    "campo": valor
  }
}
\`\`\`

Exemplo: se faltam balanco.fornecedores e dre.receita_bruta, retorne:
\`\`\`json
{
  "balanco": { "fornecedores": 1234 },
  "dre": { "receita_bruta": 5678 }
}
\`\`\``
}
