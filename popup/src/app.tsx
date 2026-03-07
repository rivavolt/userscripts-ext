import { useState, useEffect } from 'preact/hooks'
import { Switch } from '@/components/ui/switch'

interface ScriptInfo {
  id: string
  name: string
  matches: string[]
  description: string
  enabled: boolean
}

interface ScriptData {
  [id: string]: {
    name: string
    matches: string[]
    description: string
    enabled: boolean
  }
}

function matchesUrl(patterns: string[], url: string): boolean {
  for (const pattern of patterns) {
    const re = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    try {
      if (new RegExp('^' + re + '$').test(url)) return true
    } catch {}
  }
  return false
}

function ScriptRow({ script }: { script: ScriptInfo }) {
  const toggle = (checked: boolean) => {
    chrome.runtime.sendMessage({
      type: 'toggleScript',
      id: script.id,
      enabled: checked,
    })
  }

  return (
    <div className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-accent transition-colors">
      <div className="min-w-0 flex-1 mr-3">
        <div className="text-sm font-medium truncate">{script.name}</div>
        {script.matches.length > 0 && (
          <div className="text-xs text-muted-foreground truncate">
            {script.matches.join(', ')}
          </div>
        )}
      </div>
      <Switch
        size="sm"
        checked={script.enabled}
        onCheckedChange={toggle}
      />
    </div>
  )
}

function ScriptSection({ title, scripts }: { title: string; scripts: ScriptInfo[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground px-2 py-1">
        {title}
      </div>
      {scripts.map(s => <ScriptRow key={s.id} script={s} />)}
    </div>
  )
}

export function App() {
  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tabUrl, setTabUrl] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const { scriptData = {} } = await chrome.storage.local.get('scriptData') as { scriptData: ScriptData }

      const err = (scriptData as any)._error
      if (err) {
        setError(err.name)
        return
      }

      const list = Object.entries(scriptData)
        .filter(([id]) => id !== '_error')
        .map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => a.name.localeCompare(b.name))

      setScripts(list)

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        setTabUrl(tab?.url ?? null)
      } catch {}
    }

    load()

    const listener = (changes: any, area: string) => {
      if (area === 'local' && changes.scriptData) load()
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])

  if (error) {
    return (
      <div className="p-4 text-sm text-muted-foreground">{error}</div>
    )
  }

  if (scripts.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">No scripts loaded</div>
    )
  }

  const matching = tabUrl
    ? scripts.filter(s => matchesUrl(s.matches || [], tabUrl))
    : []
  const other = scripts.filter(s => !matching.includes(s))

  return (
    <div className="space-y-2">
      {matching.length > 0 && (
        <ScriptSection title={`This page (${matching.length})`} scripts={matching} />
      )}
      {other.length > 0 && (
        <ScriptSection
          title={matching.length > 0 ? `Other (${other.length})` : `All scripts (${scripts.length})`}
          scripts={other}
        />
      )}
    </div>
  )
}
