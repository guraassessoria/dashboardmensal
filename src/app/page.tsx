// O dashboard.html em /public/ faz o fetch do Supabase diretamente no browser
// Esta rota redireciona para o arquivo estático
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/dashboard.html')
}
