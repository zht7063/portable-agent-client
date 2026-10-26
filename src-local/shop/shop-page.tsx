import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { errText, pa, unwrap } from '../lib/pa'

export function ShopPage() {
  const [host, setHost] = useState('wzyp.cn')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [clear, setClear] = useState(false)
  useEffect(() => {
    const api = pa()
    const off = api.onShopHost(setHost)
    unwrap(api.shop.control({ action: 'show' })).then(r => setHost(r.host)).catch(e => setError(errText(e)))
    return () => { off(); void api.shop.control({ action: 'hide' }) }
  }, [])
  const action = async (action: 'reload' | 'open-in-browser' | 'clear-data') => {
    setBusy(true); setError('')
    try {
      await unwrap(pa().shop.control({ action }))
      if (action === 'clear-data') { setClear(false); await unwrap(pa().shop.control({ action: 'show' })) }
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return <main className='bg-background text-foreground h-svh'>
    <header style={{ height: 144 }} className='space-y-2 overflow-auto border-b p-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <a href='/' className='text-primary hover:underline'>← Back</a>
        <h1 className='font-semibold'>Shop</h1>
        <span className='text-muted-foreground text-sm' aria-live='polite'>{host}</span>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => void action('open-in-browser')}>Open in browser</Button>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => void action('reload')}>Reload</Button>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => setClear(true)}>Clear shop data</Button>
      </div>
      {clear && <div className='flex items-center gap-2 text-sm'>Clear saved shop logins and cookies?
        <Button size='sm' variant='outline' disabled={busy} onClick={() => setClear(false)}>Cancel</Button>
        <Button size='sm' variant='destructive' disabled={busy} onClick={() => void action('clear-data')}>Clear data</Button>
      </div>}
      {error && <p role='alert' className='text-destructive text-sm'>{error}</p>}
    </header>
  </main>
}
