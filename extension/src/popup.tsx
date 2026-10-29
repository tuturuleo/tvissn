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
  Copy,
  Check,
  Users,
} from "lucide-react";
import {
  DEFAULT_SERVER,
  credential,
  isNewer,
  samePage,
  serverOrigin,
  parseInvitation,
} from "./shared";
import { serviceRoutes } from "./routes";

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
    [frameOrigins, setFrameOrigins] = useState<string[]>([]),
    [invitation, setInvitation] = useState(""),
    [copied, setCopied] = useState(false),
    [newUrl, setNewUrl] = useState("");
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
      origin = serverOrigin(parseInvitation(code).server || server);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!(await chrome.permissions.request({ origins: serviceRoutes(origin).map(r => r + "/*") }))) {
      setError("Разрешите доступ к вашему серверу.");
      return;
    }
    await action(() =>
      request("LOGIN", {
        server: origin,
        name: name.trim(),
        code: credential(code),
      }),
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
          <h1 className="text-lg font-medium">Смотреть вместе</h1>
          <p className="text-xs leading-5 text-muted-foreground">
            Введите код или вставьте приглашение друга. Затем откройте YouTube
            или другой сайт с видео.
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
              onChange={(e) => {
                setCode(e.target.value);
                const invite = parseInvitation(e.target.value);
                if (invite.server) setServer(invite.server);
              }}
              required
              autoComplete="current-password"
            />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Адреса сервиса / свой сервер</summary>
            <p className="mt-2">Автовыбор: tvissn-proxy.lissn.workers.dev ↔ tvissn.onrender.com</p>
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
                {state.connectionServer && <span className="block mt-1">{state.connectionServer === DEFAULT_SERVER ? "Через прокси" : state.connectionServer === "https://tvissn.onrender.com" ? "Напрямую" : "Свой сервер"}</span>}
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
          <section
            className="rounded-lg border border-border p-3"
            aria-label="Участники комнаты"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xs font-medium">
                <Users className="size-3.5" />В комнате
              </h2>
              <Badge variant="secondary">
                {state.snapshot?.participants?.length || 0}
              </Badge>
            </div>
            <div className="space-y-3">
              {(state.snapshot?.participants || []).map((person: any) => (
                <div key={person.id} className="flex items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">
                    {Array.from(person.name)[0] as string}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">
                      {person.name}
                      {person.id === state.session.id && (
                        <span className="ml-1 text-muted-foreground">· вы</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {person.status === "ready"
                        ? "Готов к просмотру"
                        : person.status === "buffering"
                          ? "Загружает видео…"
                          : person.status === "error"
                            ? "Плеер недоступен"
                            : "Подключается…"}
                    </p>
                  </div>
                  <span
                    className={
                      "size-1.5 rounded-full " +
                      (person.status === "ready"
                        ? "bg-emerald-300/70"
                        : "bg-zinc-500")
                    }
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t border-border pt-3 text-[11px] text-muted-foreground">
              <span>Задержка до сервера</span>
              <span className="font-mono">
                {state.connected &&
                state.ping !== null &&
                state.ping !== undefined
                  ? state.ping + " мс"
                  : "—"}
              </span>
            </div>
          </section>
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
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-white"
                  checked={!!state.autoFollow}
                  onChange={(e) =>
                    action(() =>
                      request("FOLLOW", { enabled: e.target.checked }),
                    )
                  }
                />
                <span>
                  Автопереход за общим видео
                  <span className="mt-1 block text-muted-foreground">
                    Только эта вкладка. Самостоятельная смена адреса выключает
                    режим.
                  </span>
                </span>
              </label>
              {state.pendingNavigation && (
                <div className="rounded-lg border border-border p-3 text-xs">
                  <p className="mb-2 break-all">
                    Нужен доступ к {new URL(state.pendingNavigation).hostname}
                  </p>
                  <Button
                    size="sm"
                    onClick={async () => {
                      const origin = new URL(state.pendingNavigation).origin;
                      if (
                        await chrome.permissions.request({
                          origins: [origin + "/*"],
                        })
                      )
                        await action(() => request("NAVIGATE"));
                    }}
                  >
                    Разрешить и перейти
                  </Button>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(() =>
                    request("COMMAND", {
                      command: { type: "loadExternal", url: newUrl },
                    }),
                  );
                }}
                className="space-y-2"
              >
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="shared-url"
                >
                  Другое видео для всех
                </label>
                <Input
                  id="shared-url"
                  type="url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="Ссылка на страницу с видео"
                  required
                />
                <Button
                  className="w-full"
                  size="sm"
                  variant="secondary"
                  disabled={!newUrl.trim() || busy}
                >
                  Установить видео
                </Button>
              </form>
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
          <Button
            className="w-full"
            variant="outline"
            onClick={() =>
              action(async () => {
                const result = await request("INVITE");
                setInvitation(result.invitation);
                try {
                  await navigator.clipboard.writeText(result.invitation);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2500);
                } catch {
                  setError("Приглашение готово. Скопируйте его из поля ниже.");
                }
              })
            }
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Приглашение скопировано" : "Пригласить друга"}
          </Button>
          {invitation && (
            <label className="block text-xs text-muted-foreground">
              Приглашение на 7 дней
              <Input
                readOnly
                value={invitation}
                className="mt-2"
                onFocus={(e) => e.target.select()}
              />
              <span className="mt-2 block">
                Друг вставляет его в поле входа расширения. Открывать сайт не
                нужно.
              </span>
            </label>
          )}
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
