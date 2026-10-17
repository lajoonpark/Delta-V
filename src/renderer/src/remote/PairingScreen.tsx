import { useState } from 'react'
import { Smartphone } from 'lucide-react'
import { remoteConnection } from './connection'
import { useRemoteState } from './useRemoteState'

const STEPS = [
  'On your computer open Delta-V → Settings → Remote and turn it on.',
  'Make sure this phone is on the same Wi-Fi.',
  'Scan the QR code with your camera and open the link.'
]

/** First-run / re-pair screen: QR instructions plus a paste-the-link fallback. */
export function PairingScreen(): React.ReactElement {
  const { pairingNotice } = useRemoteState()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    setInvalid(!remoteConnection.pair(value.trim()))
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-hairline bg-hull">
            <Smartphone size={30} className="text-accent" />
          </div>
          <h1 className="text-lg font-semibold text-paper">Scan the QR code in Delta-V settings</h1>
        </div>

        {pairingNotice && (
          <div className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
            {pairingNotice}
          </div>
        )}

        <ol className="flex flex-col gap-3">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline bg-hull font-mono text-xs text-accent">
                {i + 1}
              </span>
              <span className="text-sm leading-relaxed text-paper/90">{step}</span>
            </li>
          ))}
        </ol>

        <form onSubmit={submit} className="mt-2 flex flex-col gap-2 border-t border-hairline pt-5">
          <label htmlFor="pair-link" className="text-xs text-muted">
            Paste pairing link
          </label>
          <input
            id="pair-link"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (invalid) setInvalid(false)
            }}
            placeholder="http://192.168.…"
            className="min-h-11 w-full rounded-xl border border-hairline bg-hull px-3 text-sm text-paper placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {invalid && <p className="text-xs text-red-400">That doesn't look like a Delta-V pairing link</p>}
          <button
            type="submit"
            disabled={value.trim().length === 0}
            className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-void active:bg-accent-dim disabled:opacity-40"
          >
            Pair
          </button>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Added to your Home Screen and seeing this again? Paste the link here — Home Screen apps keep
            their own storage.
          </p>
        </form>
      </div>
    </div>
  )
}
