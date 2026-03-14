import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'CBF — Demonstrações Financeiras',
  description: 'Dashboard financeiro da Confederação Brasileira de Futebol',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, padding: 0, background: '#0D1117' }}>
        {children}
      </body>
    </html>
  )
}
