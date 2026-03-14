import { createClient } from '@supabase/supabase-js'
import DashboardClient from './dashboard-client'

// Forçar SSR dinâmico — busca dados frescos do Supabase a cada request
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

  const atual = todos?.find(d => d.periodo === periodoAtual) || todos?.[todos.length - 1]

  return {
    periodoAtual,
    dadoAtual: atual || null,
    historico: todos || [],
    geradoEm: new Date().toISOString()
  }
}

export default async function Home() {
  const dados = await getDados()
  return <DashboardClient dados={dados} />
}