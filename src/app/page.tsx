import { createClient } from '@supabase/supabase-js'
import DashboardClient from './dashboard-client'

// Busca dados no Supabase na build (SSG) ou a cada request (SSR)
async function getDados() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Buscar período mais recente
  const { data: config } = await supabase
    .from('configuracao')
    .select('valor')
    .eq('chave', 'periodo_atual')
    .single()

  const periodoAtual = config?.valor || '2025-12'

  // Buscar todos os períodos disponíveis para série histórica
  const { data: todos } = await supabase
    .from('dados_financeiros')
    .select('*')
    .order('periodo', { ascending: true })

  // Dados do período atual
  const atual = todos?.find(d => d.periodo === periodoAtual) || todos?.[todos.length - 1]

  return {
    periodoAtual,
    dadoAtual: atual || null,
    historico: todos || [],
    geradoEm: new Date().toISOString()
  }
}

// Revalidar a cada 5 minutos (ISR)
export const revalidate = 300

export default async function Home() {
  const dados = await getDados()
  return <DashboardClient dados={dados} />
}
