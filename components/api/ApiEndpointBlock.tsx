'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ApiCodeBlock } from './ApiCodeBlock'

export type ApiLangTab = 'cURL' | 'Node.js' | 'PHP' | 'Python'
export const API_LANG_TABS: ApiLangTab[] = ['cURL', 'Node.js', 'PHP', 'Python']

export function ApiEndpointBlock({
    method, path, description, queryParams, requestBody, responseBody, notes, samples,
}: {
    method: 'GET' | 'POST'; path: string; description: string
    queryParams?: { name: string; type: string; required: boolean; desc: string }[]
    requestBody?: string; responseBody: string; notes?: string[]
    samples: Record<ApiLangTab, string>
}) {
    const [lang, setLang] = useState<ApiLangTab>('cURL')
    const methodColor = method === 'GET'
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
        : 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30'

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex-wrap gap-y-2">
                <span className={cn('inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border tracking-wide font-mono', methodColor)}>
                    {method}
                </span>
                <code className="text-sm font-mono font-semibold text-slate-800 dark:text-slate-100 break-all">{path}</code>
            </div>
            <div className="p-5 space-y-5">
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{description}</p>

                {queryParams && queryParams.length > 0 && (
                    <div>
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Query Parameters</p>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
                            {queryParams.map(p => (
                                <div key={p.name} className="flex flex-wrap items-start gap-2 px-4 py-3">
                                    <code className="font-mono text-violet-600 dark:text-violet-400 text-xs font-bold w-20 flex-shrink-0 mt-0.5">{p.name}</code>
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 uppercase">{p.type}</span>
                                    {!p.required && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 uppercase">optional</span>}
                                    <span className="text-xs text-slate-600 dark:text-slate-400 flex-1 min-w-[120px]">{p.desc}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className={cn('grid gap-4', requestBody ? 'sm:grid-cols-2' : 'grid-cols-1 max-w-lg')}>
                    {requestBody && (
                        <div>
                            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Request Body</p>
                            <ApiCodeBlock code={requestBody} />
                        </div>
                    )}
                    <div>
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Response</p>
                        <ApiCodeBlock code={responseBody} />
                    </div>
                </div>

                {notes && notes.length > 0 && (
                    <ul className="space-y-1.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-4">
                        {notes.map((n, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
                                <span className="text-violet-500 font-bold mt-0.5 flex-shrink-0">→</span>
                                <span className="leading-relaxed">{n}</span>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="space-y-2">
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Code Sample</p>
                    <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
                        {API_LANG_TABS.map(l => (
                            <button key={l} onClick={() => setLang(l)}
                                className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                                    lang === l
                                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                )}>{l}</button>
                        ))}
                    </div>
                    <ApiCodeBlock code={samples[lang]} lang={lang} />
                </div>
            </div>
        </div>
    )
}
