import { samePage } from "./shared";
interface Hooks {
  hasPermission: (origin: string) => Promise<boolean>;
  navigate: (tabId: number, url: string) => Promise<unknown>;
  notify: (message: string) => void;
  changed: () => void;
}
/** Only a user-selected tab can be navigated, and only after explicit opt-in. */
export class FollowMode {
  enabled = false;
  tabId: number | null = null;
  pendingGrant: string | null = null;
  private expected: string | null = null;
  private shared: string | null = null;
  private revision = -1;
  private generation = 0;
  constructor(private hooks: Hooks) {}
  configure(enabled: boolean, tabId: number | null) {
    this.enabled = enabled;
    this.tabId = tabId;
    this.pendingGrant = null;
    this.expected = null;
    this.revision = -1;
    this.generation++;
    this.hooks.changed();
  }
  async update(url: string | null | undefined, revision: number) {
    if (
      !url ||
      !this.enabled ||
      this.tabId === null ||
      this.revision === revision
    )
      return;
    this.revision = revision;
    this.shared = url;
    const generation = ++this.generation;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      this.disable("Автопереход остановлен: недопустимая ссылка.");
      return;
    }
    if (!(await this.hooks.hasPermission(parsed.origin))) {
      if (generation !== this.generation) return;
      this.pendingGrant = url;
      this.hooks.notify(
        "Для нового сайта нужен доступ. Откройте расширение и разрешите переход.",
      );
      this.hooks.changed();
      return;
    }
    if (generation !== this.generation || !this.enabled || this.tabId === null)
      return;
    this.pendingGrant = null;
    this.expected = url;
    this.hooks.changed();
    try {
      await this.hooks.navigate(this.tabId, url);
    } catch {
      this.expected = null;
      this.disable(
        "Не удалось выполнить автопереход. Подключите вкладку повторно.",
      );
    }
  }
  async retry() {
    if (!this.pendingGrant) return;
    const url = this.pendingGrant;
    const revision = this.revision;
    this.revision = -1;
    await this.update(url, revision);
  }
  onUrl(tabId: number, url: string) {
    if (!this.enabled || tabId !== this.tabId) return;
    if (this.expected) {
      try {
        if (
          samePage(url, this.expected) ||
          new URL(url).origin === new URL(this.expected).origin
        )
          return;
      } catch {}
      this.disable(
        "Автопереход выключен: страница перенаправила на другой сайт.",
      );
      return;
    }
    if (this.shared && !samePage(url, this.shared))
      this.disable(
        "Автопереход выключен после самостоятельной смены страницы.",
      );
  }
  complete(tabId: number, url: string) {
    if (tabId !== this.tabId || !this.expected) return;
    if (!samePage(url, this.expected)) {
      this.disable("Автопереход выключен: источник изменил адрес.");
      return;
    }
    this.expected = null;
  }
  private disable(message: string) {
    this.enabled = false;
    this.expected = null;
    this.pendingGrant = null;
    this.generation++;
    this.hooks.notify(message);
    this.hooks.changed();
  }
}
