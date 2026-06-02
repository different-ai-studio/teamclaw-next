import * as React from 'react'
import { Check, Loader2, Download, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'

function StatusIcon({ req, installing }: { req: RequirementStatus; installing: boolean }) {
  if (req.present) return <Check className="h-4 w-4 text-coral" />
  if (installing) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  return <Download className="h-4 w-4 text-faint" />
}

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { requirements, installing, output, errors, loaded, listRequirements, install, requiredSatisfied } =
    useSetupStore()

  React.useEffect(() => {
    void listRequirements()
  }, [listRequirements])

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background" data-tauri-drag-region>
      <div className="h-10 shrink-0" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center gap-4 px-6 pb-12">
        <div>
          <h1 className="text-[15px] font-bold text-foreground">准备运行环境</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            首次启动需要安装本机依赖,稍等片刻即可。
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {requirements.map((req) => {
            const isInstalling = installing === req.id
            const lines = output[req.id] ?? []
            const err = errors[req.id]
            return (
              <div key={req.id} className="rounded-[16px] border border-border bg-paper p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <StatusIcon req={req} installing={isInstalling} />
                    <span className="text-[13px] font-semibold text-foreground">{req.title}</span>
                    {req.optional && (
                      <span className="rounded-[4px] bg-panel px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        可选
                      </span>
                    )}
                  </div>
                  {req.present ? (
                    <span className="font-mono text-[11px] text-faint">已就绪</span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={installing !== null}
                      onClick={() => void install(req.id)}
                    >
                      {isInstalling ? '安装中…' : '安装'}
                    </Button>
                  )}
                </div>
                {req.version && (
                  <p className="mt-1 font-mono text-[11px] text-faint">{req.version}</p>
                )}
                {isInstalling && lines.length > 0 && (
                  <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                    {lines[lines.length - 1]}
                  </p>
                )}
                {err && (
                  <p className="mt-2 flex items-center gap-1 text-[11.5px] text-coral">
                    <AlertCircle className="h-3 w-3" /> {err}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <Button
          className="mt-2 h-10 bg-coral text-paper hover:opacity-90"
          disabled={!requiredSatisfied() || installing !== null}
          onClick={onDone}
        >
          {requiredSatisfied() ? '继续' : '请先安装必需项'}
        </Button>
      </div>
    </div>
  )
}
