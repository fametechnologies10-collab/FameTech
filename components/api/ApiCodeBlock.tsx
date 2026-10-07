'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Check, Copy } from 'lucide-react'

export function ApiCopyBtn({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try { await navigator.clipboard.writeText(text) } catch {
            const el = Object.assign(document.createElement('textarea'), { value: text })
            document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove()
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }
    return (
        <button onClick={copy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 hover:text-white border border-slate-600 transition-all">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    )
}

export function ApiCodeBlock({ code, lang }: { code: string; lang?: string }) {
    return (
        <div className="rounded-xl overflow-hidden border border-slate-700/50">
            <div className="flex items-center justify-between pl-4 pr-2 py-2 bg-slate-800/80 border-b border-slate-700/50">
                {lang && <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{lang}</span>}
                <ApiCopyBtn text={code} />
            </div>
            <div className="bg-[#0d1117] overflow-x-auto p-4">
                <pre className="text-[13px] font-mono text-slate-300 leading-relaxed whitespace-pre">{code}</pre>
            </div>
        </div>
    )
}
