import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  Link2,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  TvMinimalPlay,
  Users,
  Volume2,
  VolumeX,
  Expand,
  LockKeyhole,
  Radio,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { YoutubePlayer } from "@/components/youtube-player";
import { useRoom } from "@/lib/use-room";
import { invitationLink, takeInvitation } from "@/lib/invite";
import { positionAt } from "../server/timeline";
import { formatTime } from "@/lib/youtube";

interface Session {
  id: string;
  name: string;
}
const Brand = () => (
  <a className="brand" href="/" aria-label="tvissn — главная">
    <span className="brand-icon">
      <TvMinimalPlay className="size-5" />
    </span>
    <span>
      tvissn<span className="brand-dot">.</span>
    </span>
  </a>
);
function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [initialError, setInitialError] = useState("");
  const check = useCallback(async () => {
    setLoading(true);
    setInitialError("");
    try {
      const res = await fetch("/api/session");
      if (res.ok) setSession(await res.json());
      else if (res.status !== 401) throw new Error();
    } catch {
      setInitialError("Не удалось связаться с сервером. Попробуйте ещё раз.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  return (
    <TooltipProvider delayDuration={250}>
      {loading ? (
        <div className="loading-page">
          <Brand />
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          <p>Подключаемся…</p>
        </div>
      ) : session ? (
        <Room
          session={session}
          onExpired={() => setSession(null)}
          onLogout={async () => {
            await fetch("/api/logout", { method: "POST" });
            sessionStorage.removeItem("tvissn-invite");
            setSession(null);
          }}
        />
      ) : (
        <Login
          onLogin={setSession}
          initialError={initialError}
          onRetry={check}
        />
      )}
    </TooltipProvider>
  );
}
function Login({
  onLogin,
  initialError,
  onRetry,
}: {
  onLogin: (s: Session) => void;
  initialError: string;
  onRetry: () => void;
}) {
  const [name, setName] = useState(
      () => localStorage.getItem("tvissn-name") || "",
    ),
    [code, setCode] = useState(takeInvitation),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, code }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          data.error ||
            (res.status === 429
              ? "Слишком много попыток. Подождите минуту."
              : "Не удалось войти."),
        );
      localStorage.setItem("tvissn-name", name.trim());
      sessionStorage.setItem("tvissn-invite", code.trim());
      onLogin(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <header className="site-header">
        <Brand />
        <Badge variant="outline" className="gap-2">
          <LockKeyhole className="size-3" />
          Для своих
        </Badge>
      </header>
      <main className="login-layout">
        <section className="login-intro">
          <span className="eyebrow">ВАШ ОБЩИЙ ЭКРАН</span>
          <h1>
            На одной <br />
            волне<span className="text-muted-foreground">.</span>
          </h1>
          <p>
            Видео, которое хочется показать.
            <br />
            Друзья, с которыми хочется смотреть.
          </p>
          <div className="intro-bottom">
            <span className="inline-flex items-center gap-2">
              <span className="status-dot" />
              YouTube · вместе и синхронно
            </span>
            <div className="timeline-decoration" aria-hidden="true">
              <span />
              <i />
              <span />
              <i />
              <span />
            </div>
          </div>
        </section>
        <section className="login-card" aria-labelledby="login-title">
          <div className="mb-7 flex size-11 items-center justify-center rounded-xl border border-border bg-secondary">
            <LockKeyhole className="size-5" />
          </div>
          <h2 id="login-title">Присоединиться к просмотру</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Введите имя и код, которым с вами поделились.
          </p>
          <form onSubmit={submit} className="mt-8 space-y-5">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                Ваше имя
              </label>
              <Input
                id="name"
                placeholder="Как вас называть?"
                autoComplete="nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                required
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="code" className="text-sm font-medium">
                Код приглашения
              </label>
              <Input
                id="code"
                type="password"
                placeholder="Введите код"
                autoComplete="current-password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={128}
                required
                disabled={busy}
              />
            </div>
            {(error || initialError) && (
              <p role="alert" className="text-sm text-destructive">
                {error || initialError}
                {initialError && (
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={onRetry}
                  >
                    Повторить
                  </button>
                )}
              </p>
            )}
            <Button
              className="h-11 w-full"
              disabled={busy || !name.trim() || !code.trim()}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <>
                  Войти
                  <ArrowRight className="ml-auto" />
                </>
              )}
            </Button>
          </form>
          <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            Одна комната. Все управляют просмотром.
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <span>Хорошее видео становится лучше вместе.</span>
        <a href="/extension" className="underline underline-offset-4">
          Расширение tvissn
        </a>
      </footer>
    </div>
  );
}
function Room({
  session,
  onLogout,
  onExpired,
}: {
  session: Session;
  onLogout: () => Promise<void>;
  onExpired: () => void;
}) {
  const room = useRoom(onExpired),
    [url, setUrl] = useState(""),
    [copied, setCopied] = useState(false),
    [help, setHelp] = useState(false),
    [source, setSource] = useState<"youtube" | "external">("youtube");
  const [metrics, setMetrics] = useState({
      position: 0,
      duration: 0,
      drift: 0,
      title: "",
      rates: [1],
    }),
    [resyncKey, setResyncKey] = useState(0),
    [muted, setMuted] = useState(false),
    [leaving, setLeaving] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const player = useRef<YT.Player | null>(null),
    surface = useRef<HTMLDivElement>(null);
  const state = room.snapshot?.playback;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!state?.externalUrl) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [state?.externalUrl]);
  const playPosition = state?.externalUrl
    ? positionAt(state, room.serverNow())
    : metrics.position;
  const hasVideo = !!(state?.videoId || state?.externalUrl),
    disabled = !room.connected || !hasVideo;
  const sync = () => {
    room.resync();
    setResyncKey((n) => n + 1);
  };
  const seek = (position: number) =>
    room.command({
      type: "seek",
      position: Math.max(0, Math.min(metrics.duration || 604800, position)),
    });
  const load = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    room.command({
      type: source === "youtube" ? "load" : "loadExternal",
      url: url.trim(),
    });
  };
  const mrev = state?.mediaRevision;
  useEffect(() => {
    setMetrics({ position: 0, duration: 0, drift: 0, title: "", rates: [1] });
    setScrub(null);
    setMuted(false);
  }, [mrev]);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,button,[role="slider"]',
        ) ||
        e.altKey ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      if (!room.connected || (!state?.videoId && !state?.externalUrl)) return;
      if (e.code === "Space") {
        e.preventDefault();
        room.command({ type: state.playing ? "pause" : "play" });
      }
      if (e.code === "ArrowRight") {
        e.preventDefault();
        seek(playPosition + 10);
      }
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        seek(playPosition - 10);
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [state, room.connected, playPosition]);
  const participants = room.snapshot?.participants || [];
  const names = participants.length;
  const position = scrub ?? playPosition;
  return (
    <div className="room-page">
      <header className="site-header">
        <div className="flex items-center gap-5">
          <Brand />
          <span className="header-divider" />
          <span className="hidden text-sm text-muted-foreground sm:inline">
            Общий просмотр
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="connection-badge">
            <span className={`status-dot ${room.connected ? "" : "offline"}`} />
            {room.connected ? "В комнате" : "Подключаемся"}
          </Badge>
          <Hint label="Выйти">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Выйти из просмотра"
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  await onLogout();
                } catch {
                  room.setError("Не удалось выйти. Повторите попытку.");
                  setLeaving(false);
                }
              }}
            >
              <LogOut />
            </Button>
          </Hint>
        </div>
      </header>
      <main className="room-main">
        <div className="room-title-row">
          <div>
            <span className="eyebrow">ВЕЧЕР В ХОРОШЕЙ КОМПАНИИ</span>
            <h1>
              Смотрим вместе<span className="text-muted-foreground">.</span>
            </h1>
          </div>
          <Hint label="Скопировать ссылку с заполненным кодом приглашения.">
            <Button
              variant="outline"
              aria-label="Пригласить друга: скопировать ссылку"
              onClick={async () => {
                try {
                  const code =
                    sessionStorage.getItem("tvissn-invite") ||
                    window.prompt("Введите код приглашения для ссылки:");
                  if (!code) return;
                  sessionStorage.setItem("tvissn-invite", code);
                  await navigator.clipboard.writeText(
                    invitationLink(location.origin, code),
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  room.setError(
                    "Не удалось скопировать адрес. Скопируйте его из адресной строки.",
                  );
                }
              }}
            >
              {copied ? <Check /> : <Link2 />}
              <span className="hidden sm:inline">
                {copied ? "Ссылка скопирована" : "Пригласить друга"}
              </span>
            </Button>
          </Hint>
        </div>
        <div className="room-grid">
          <section className="watch-column" aria-label="Совместный просмотр">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={source === "youtube" ? "secondary" : "ghost"}
                onClick={() => setSource("youtube")}
              >
                YouTube
              </Button>
              <Button
                size="sm"
                variant={source === "external" ? "secondary" : "ghost"}
                onClick={() => setSource("external")}
              >
                Внешний сайт
              </Button>
              <a
                className="ml-auto text-xs text-muted-foreground underline underline-offset-4"
                href="/extension"
                target="_blank"
                rel="noopener noreferrer"
              >
                Скачать расширение
              </a>
            </div>
            <form className="source-form" onSubmit={load}>
              <div className="source-icon">
                <Link2 className="size-4" />
              </div>
              <label className="sr-only" htmlFor="video-url">
                Ссылка на видео YouTube
              </label>
              <Input
                id="video-url"
                type="url"
                placeholder={
                  source === "youtube"
                    ? "Вставьте ссылку на видео YouTube"
                    : "Ссылка на страницу с видео"
                }
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!room.connected}
                required
              />
              <Button disabled={!room.connected || !url.trim()} type="submit">
                Смотреть
                <ArrowRight />
              </Button>
            </form>
            {room.error && (
              <div role="alert" className="error-banner">
                <AlertCircle className="size-4 shrink-0" />
                {room.error}
                <button
                  className="ml-auto shrink-0 underline"
                  onClick={() => room.setError("")}
                >
                  Закрыть
                </button>
              </div>
            )}
            {!room.connected && (
              <div className="reconnect-banner" role="status">
                <LoaderCircle className="size-4 animate-spin" />
                Восстанавливаем соединение. Просмотр продолжится после
                подключения.
              </div>
            )}
            <div className="player-card" ref={surface}>
              {state?.externalUrl ? (
                <div className="empty-player external-player">
                  <Link2 className="mb-5 size-8 text-muted-foreground" />
                  <h2>Смотрим на другом сайте</h2>
                  <p className="max-w-sm px-4">
                    Откройте страницу у себя и подключите вкладку в расширении
                    tvissn.
                  </p>
                  <a
                    href={state.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-5"
                  >
                    <Button>
                      Открыть страницу <ArrowRight />
                    </Button>
                  </a>
                  <a
                    href="/extension"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 text-xs text-muted-foreground underline"
                  >
                    Установить расширение
                  </a>
                </div>
              ) : hasVideo && state ? (
                <YoutubePlayer
                  state={state}
                  connected={room.connected}
                  serverNow={room.serverNow}
                  onCommand={room.command}
                  onStatus={room.report}
                  onMetrics={setMetrics}
                  playerRef={player}
                  resyncKey={resyncKey}
                />
              ) : (
                <div className="empty-player">
                  <span className="empty-play-icon">
                    <Play className="size-7 fill-current" />
                  </span>
                  <h2>С чего начнём?</h2>
                  <p>
                    Добавьте ссылку на YouTube.
                    <br />
                    Видео появится у всех в комнате.
                  </p>
                  <span className="empty-label">
                    <LockKeyhole className="size-3" />
                    Только вы и ваши друзья
                  </span>
                </div>
              )}
              <div className="playback-panel">
                <div className="seek-row">
                  <span className="timecode">{formatTime(position)}</span>
                  <Slider
                    aria-label="Позиция видео"
                    min={0}
                    max={metrics.duration || 1}
                    step={1}
                    value={[Math.min(position, metrics.duration || 1)]}
                    disabled={disabled || !metrics.duration}
                    onValueChange={(v) => setScrub(v[0])}
                    onValueCommit={(v) => {
                      seek(v[0]);
                      setScrub(null);
                    }}
                  />
                  <span className="timecode">
                    {formatTime(metrics.duration)}
                  </span>
                </div>
                <div className="controls-row">
                  <div className="flex items-center gap-1">
                    <Hint label="Назад на 10 секунд">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Назад на 10 секунд"
                        disabled={disabled}
                        onClick={() => seek(playPosition - 10)}
                      >
                        <SkipBack />
                      </Button>
                    </Hint>
                    <Hint
                      label={
                        state?.playing
                          ? "Пауза для всех"
                          : "Воспроизвести для всех"
                      }
                    >
                      <Button
                        size="icon"
                        className="play-button"
                        aria-label={
                          state?.playing
                            ? "Пауза для всех"
                            : "Воспроизвести для всех"
                        }
                        disabled={disabled}
                        onClick={() => {
                          if (state && !state.playing)
                            player.current?.playVideo();
                          room.command({
                            type: state?.playing ? "pause" : "play",
                          });
                        }}
                      >
                        {state?.playing ? (
                          <Pause className="fill-current" />
                        ) : (
                          <Play className="fill-current" />
                        )}
                      </Button>
                    </Hint>
                    <Hint label="Вперёд на 10 секунд">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Вперёд на 10 секунд"
                        disabled={disabled}
                        onClick={() => seek(playPosition + 10)}
                      >
                        <SkipForward />
                      </Button>
                    </Hint>
                    <span className="controls-divider" />
                    <Hint
                      label={
                        muted ? "Включить звук у себя" : "Выключить звук у себя"
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={muted ? "Включить звук" : "Выключить звук"}
                        disabled={disabled}
                        onClick={() => {
                          if (!player.current) return;
                          if (muted) player.current.unMute();
                          else player.current.mute();
                          setMuted(!muted);
                        }}
                      >
                        {muted ? <VolumeX /> : <Volume2 />}
                      </Button>
                    </Hint>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor="rate">
                      Общая скорость
                    </label>
                    <select
                      id="rate"
                      className="rate-select"
                      disabled={disabled}
                      value={state?.rate || 1}
                      onChange={(e) =>
                        room.command({
                          type: "rate",
                          rate: Number(e.target.value),
                        })
                      }
                    >
                      {[...new Set([...metrics.rates, state?.rate || 1])]
                        .sort((a, b) => a - b)
                        .map((r) => (
                          <option key={r} value={r}>
                            {r}×
                          </option>
                        ))}
                    </select>
                    <Hint label="Синхронизировать мой плеер">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Синхронизировать мой плеер"
                        disabled={disabled}
                        onClick={sync}
                      >
                        <RefreshCw />
                      </Button>
                    </Hint>
                    <Hint label="На весь экран">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="На весь экран"
                        disabled={!hasVideo}
                        onClick={() => {
                          const unavailable = () =>
                            room.setError(
                              "Полноэкранный режим недоступен в этом браузере. Используйте кнопку YouTube.",
                            );
                          if (document.fullscreenElement)
                            void document.exitFullscreen().catch(unavailable);
                          else if (surface.current?.requestFullscreen)
                            void surface.current
                              .requestFullscreen()
                              .catch(unavailable);
                          else unavailable();
                        }}
                      >
                        <Expand />
                      </Button>
                    </Hint>
                  </div>
                </div>
              </div>
            </div>
            <div className="now-playing">
              <div className="min-w-0">
                <span className="eyebrow">
                  {hasVideo ? "СЕЙЧАС СМОТРИМ" : "ВСЁ ГОТОВО К ПРОСМОТРУ"}
                </span>
                <h2 className="truncate">
                  {hasVideo
                    ? state?.externalUrl
                      ? new URL(state.externalUrl).hostname
                      : metrics.title || "Видео YouTube"
                    : "Выберите первое видео"}
                </h2>
                {state?.videoId && (
                  <a
                    className="video-origin"
                    target="_blank"
                    rel="noopener noreferrer"
                    href={`https://www.youtube.com/watch?v=${state?.videoId}`}
                  >
                    Открыть в YouTube ↗
                  </a>
                )}
              </div>
              <Badge variant="secondary" className="shrink-0 gap-1.5">
                <Radio className="size-3" />
                {state?.externalUrl ? "Внешний сайт" : "YouTube"}
              </Badge>
            </div>
            <div className="watch-footnote">
              <span>
                <CheckCircle2 className="size-3.5" />
                {room.connected
                  ? "У всех одинаковые права управления"
                  : "Управление недоступно без соединения"}
              </span>
              <button onClick={() => setHelp((v) => !v)} aria-expanded={help}>
                <CircleHelp className="size-3.5" />
                Как это работает
              </button>
            </div>
            {help && (
              <div className="help-panel">
                <p>
                  Любой участник может выбрать видео, поставить его на паузу или
                  перемотать — действие применится у всех. Громкость и
                  полноэкранный режим меняются только у вас.
                </p>
                <p>
                  Если браузер блокирует запуск, нажмите «Подключиться к
                  просмотру». Реклама и буферизация YouTube могут временно
                  влиять на синхронизацию. Кнопка ↻ вернёт ваш плеер к общей
                  позиции.
                </p>
              </div>
            )}
          </section>
          <aside className="participants-panel">
            <div className="participants-heading">
              <h2>
                <Users className="size-4" />В комнате
              </h2>
              <Badge variant="secondary">{names}</Badge>
            </div>
            <div className="participants-list">
              {participants.map((p) => (
                <div className="participant" key={p.id}>
                  <span className="avatar" aria-hidden="true">
                    {Array.from(p.name)[0]?.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="participant-name truncate">
                        {p.name}
                      </span>
                      {p.id === session.id && (
                        <span className="self-label">вы</span>
                      )}
                    </div>
                    <span className="participant-status">
                      {p.status === "ready"
                        ? "Готов к просмотру"
                        : p.status === "buffering"
                          ? "Загружает видео…"
                          : p.status === "error"
                            ? "Видео недоступно"
                            : "Подключается…"}
                    </span>
                  </div>
                  <span
                    className={`status-dot ${p.status === "ready" ? "" : p.status === "error" ? "offline" : "waiting"}`}
                  />
                </div>
              ))}
              {!names && (
                <p className="text-sm text-muted-foreground">
                  Подключаем участников…
                </p>
              )}
            </div>
            <div className="participants-note">
              <span className="note-icon">
                <Users className="size-4" />
              </span>
              <p>
                Хорошая компания —<br />
                лучший повод нажать play.
              </p>
            </div>
            <div className="sync-status">
              <span
                className={`status-dot ${room.connected ? "" : "offline"}`}
              />
              <span>{room.connected ? "На связи" : "Нет соединения"}</span>
              <span className="ml-auto font-mono text-xs">
                {room.ping === null ? "—" : `${room.ping} мс`}
              </span>
            </div>
          </aside>
        </div>
      </main>
      <footer className="site-footer">
        <span>Один экран. Один момент.</span>
        <a href="/extension" className="underline underline-offset-4">
          Расширение tvissn
        </a>
      </footer>
    </div>
  );
}
