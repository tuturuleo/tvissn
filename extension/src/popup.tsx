import { createRoot } from "react-dom/client";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { Badge } from "../../src/components/ui/badge";
import {
  Download,
  Link2,
  LogOut,
  RefreshCw,
  TvMinimalPlay,
  Play,
  Pause,
  ArrowRight,
  LoaderCircle,
  ExternalLink,
} from "lucide-react";
import {
  DEFAULT_SERVER,
  credential,
  isNewer,
  samePage,
  serverOrigin,
} from "./shared";

async function request(type: string, data: Record<string, unknown> = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok)
    throw new Error(
      r?.error || "Расширение не ответило. Откройте его ещё раз.",
    );
  return r.result;
}
function Popup() {
  const [state, setState] = useState<any>(null),
    [update, setUpdate] = useState<any>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [server, setServer] = useState(DEFAULT_SERVER),
    [tab, setTab] = useState<chrome.tabs.Tab | null>(null),
    [frameOrigins, setFrameOrigins] = useState<string[]>([]);
  async function refresh() {
    try {
      setState(await request("STATE"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function check() {
    setChecking(true);
    try {
      setUpdate(await request("UPDATE"));
    } catch (e) {
      setUpdate({ error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    const port = chrome.runtime.connect({ name: "popup" });
    void refresh();
    void check();
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((t) => setTab(t[0] || null));
    const timer = setInterval(refresh, 1500);
    return () => {
      clearInterval(timer);
      port.disconnect();
    };
  }, []);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    let origin: string;
    try {
      origin = serverOrigin(server);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!(await chrome.permissions.request({ origins: [origin + "/*"] }))) {
      setError("Разрешите доступ к вашему серверу.");
      return;
    }
    await action(() =>
      request("LOGIN", { server, name: name.trim(), code: credential(code) }),
    );
  }
  async function attach() {
    if (!tab?.id || !tab.url) return;
    // Permission is requested directly from the user's button click.
    const url = new URL(tab.url);
    if (!["https:", "http:"].includes(url.protocol)) {
      setError("Откройте обычную страницу с видео.");
      return;
    }
    const granted = await chrome.permissions.request({
      origins: [url.origin + "/*"],
    });
    if (!granted) {
      setError("Для подключения нужно разрешить доступ к этому сайту.");
      return;
    }
    await action(async () => {
      await request("ATTACH", { tabId: tab.id });
      const frames = await request("IFRAMES", { tabId: tab.id });
      setFrameOrigins(
        frames.origins.filter((o: string) => o !== url.origin + "/*"),
      );
    });
  }
  const newVersion =
      update?.version &&
      isNewer(update.version, chrome.runtime.getManifest().version),
    playback = state?.snapshot?.playback;
  return (
    <div className="extension-root">
      <header className="extension-header">
        <div className="flex items-center gap-2">
          <TvMinimalPlay className="size-5" />
          <strong>tvissn.</strong>
        </div>
        <Badge variant="outline">v{chrome.runtime.getManifest().version}</Badge>
      </header>
      {newVersion && (
        <section className="extension-update" aria-live="polite">
          <strong>Доступна версия {update.version}</strong>
          <p>
            Скачайте ZIP, замените файлы установленной папки и нажмите ↻ в
            chrome://extensions. ID и настройки сохранятся.
          </p>
          <Button
            className="w-full"
            onClick={() => void chrome.tabs.create({ url: update.downloadUrl })}
          >
            <Download />
            Скачать обновление
          </Button>
        </section>
      )}
      {!state ? (
        <div className="p-6 text-sm text-muted-foreground">
          <LoaderCircle className="mb-3 size-5 animate-spin" />
          Подключаем расширение…
        </div>
      ) : !state.session ? (
        <form onSubmit={login} className="space-y-4 p-5">
          <h1 className="text-lg font-medium">Смотреть на других сайтах</h1>
          <p className="text-xs leading-5 text-muted-foreground">
            Войдите с тем же кодом, что на сайте tvissn. Затем откройте вкладку
            с видео.
          </p>
          <label className="block space-y-2 text-xs">
            Ваше имя
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={32}
              autoComplete="nickname"
            />
          </label>
          <label className="block space-y-2 text-xs">
            Код или ссылка приглашения
            <Input
              value={code}
              type="password"
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Адрес своего сервера</summary>
            <Input
              className="mt-2"
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              required
            />
          </details>
          <Button
            className="w-full"
            disabled={busy || !name.trim() || !code.trim()}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <>
                Войти
                <ArrowRight />
              </>
            )}
          </Button>
        </form>
      ) : (
        <main className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-medium">{state.session.name}</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {state.connected ? "В комнате" : "Соединяемся…"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Выйти"
              onClick={() => action(() => request("LOGOUT"))}
            >
              <LogOut />
            </Button>
          </div>
          {playback?.externalUrl && (
            <div className="rounded-lg border border-border bg-card p-3">
              <span className="text-xs text-muted-foreground">
                Общая страница
              </span>
              <p className="my-2 break-all text-xs">{playback.externalUrl}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void chrome.tabs.create({ url: playback.externalUrl })
                }
              >
                <ExternalLink />
                Открыть страницу
              </Button>
            </div>
          )}
          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Текущая вкладка
            </p>
            <p className="mb-3 truncate text-sm">
              {tab?.title || "Откройте сайт с видео"}
            </p>
            <Button
              className="w-full"
              disabled={
                busy || !state.connected || !tab?.url?.startsWith("http")
              }
              onClick={attach}
            >
              <Link2 />
              {playback?.externalUrl &&
              samePage(tab?.url || "", playback.externalUrl)
                ? "Подключить эту вкладку"
                : "Смотреть эту страницу вместе"}
            </Button>
          </div>
          {!!frameOrigins.length && (
            <div className="text-xs leading-5 text-muted-foreground">
              <p>
                Если видео во встроенном плеере не найдено, разрешите доступ к
                его источникам:
              </p>
              <Button
                className="mt-2"
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (
                    await chrome.permissions.request({ origins: frameOrigins })
                  ) {
                    await action(() => request("ATTACH", { tabId: tab?.id }));
                    setFrameOrigins([]);
                  }
                }}
              >
                Разрешить встроенный плеер
              </Button>
              <p className="mt-2 break-all">{frameOrigins.join(", ")}</p>
            </div>
          )}
          {state.enabled && (
            <div className="space-y-3">
              <Button
                className="w-full"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request("RESCAN");
                    const frames = await request("IFRAMES", {
                      tabId: state.targetTab,
                    });
                    setFrameOrigins(frames.origins);
                  })
                }
              >
                <RefreshCw />
                Найти плееры заново
              </Button>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  variant="secondary"
                  disabled={!state.connected || !playback?.externalUrl}
                  onClick={() =>
                    action(() =>
                      request("COMMAND", {
                        command: { type: playback.playing ? "pause" : "play" },
                      }),
                    )
                  }
                >
                  {playback?.playing ? <Pause /> : <Play />}
                  {playback?.playing ? "Пауза для всех" : "Смотреть вместе"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => action(() => request("STOP"))}
                >
                  Отключить
                </Button>
              </div>
              {state.candidates.length > 1 && (
                <label className="block text-xs text-muted-foreground">
                  Плеер
                  <select
                    className="mt-2 w-full rounded-md border border-input bg-background p-2"
                    value={state.selectedPlayer ?? "auto"}
                    onChange={(e) =>
                      action(() =>
                        request("PLAYER", {
                          playerId:
                            e.target.value === "auto" ? null : e.target.value,
                        }),
                      )
                    }
                  >
                    <option value="auto">Автоматически</option>
                    {state.candidates.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.title || "Видео"} · frame {c.frameId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!state.candidates.length && (
                <p className="text-xs text-muted-foreground">
                  Плеер пока не найден. Запустите видео на странице или
                  разрешите доступ к iframe.
                </p>
              )}
            </div>
          )}
          <a
            className="inline-flex items-center gap-2 text-xs text-muted-foreground underline"
            href={state.session.server}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть tvissn <ExternalLink className="size-3" />
          </a>
        </main>
      )}
      {(error || state?.error) && (
        <p
          className="mx-5 mb-4 text-xs leading-5 text-destructive"
          role="alert"
        >
          {error || state.error}
        </p>
      )}
      <footer className="extension-footer">
        <span>
          {update?.error ||
            (newVersion
              ? "Есть обновление"
              : update
                ? "Установлена актуальная версия"
                : "Проверяем обновления…")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Проверить обновления"
          disabled={checking}
          onClick={check}
        >
          <RefreshCw className={checking ? "animate-spin" : ""} />
        </Button>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Popup />);
