"use client";

import {
  Archive,
  BarChart3,
  Bell,
  Building2,
  CheckCheck,
  CircleCheckBig,
  FileStack,
  FileText,
  GitBranch,
  History,
  ListTodo,
  LogOut,
  Menu,
  Plus,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Shapes,
  Users,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, patch, post } from "@/lib/api";
import { GameLauncher } from "@/components/game/GameLauncher";
import { dateTime, fullName, initials } from "@/lib/format";
import { useDocuments, useMe, useMyTasks, useNotifications, useVersionInfo } from "@/lib/queries";
import type { Capabilities, NotificationItem } from "@/lib/types";

type NavLink = { href: string; label: string; icon: ReactNode; requires?: keyof Capabilities; badge?: "tasks" };

const workLinks: NavLink[] = [
  { href: "/", label: "Do zrobienia przeze mnie", icon: <ListTodo size={18} />, badge: "tasks" },
  { href: "/done", label: "Wykonane przeze mnie", icon: <CheckCheck size={18} /> },
  { href: "/finished", label: "Zakończone", icon: <CircleCheckBig size={18} /> }
];

const documentLinks: NavLink[] = [
  { href: "/my-documents", label: "Moje dokumenty", icon: <FileText size={18} />, requires: "createDocuments" },
  { href: "/documents", label: "Przegląd dokumentów", icon: <FileStack size={18} /> },
  { href: "/archive", label: "Do archiwizacji", icon: <Archive size={18} />, requires: "archiveDocuments" }
];

const controlLinks: NavLink[] = [
  { href: "/reports", label: "Raporty", icon: <BarChart3 size={18} />, requires: "viewReports" },
  { href: "/audit", label: "Dziennik zdarzeń", icon: <History size={18} />, requires: "viewAudit" }
];

const adminLinks: NavLink[] = [
  { href: "/admin/users", label: "Użytkownicy", icon: <Users size={18} />, requires: "manageUsers" },
  { href: "/admin/departments", label: "Działy", icon: <Building2 size={18} />, requires: "manageUsers" },
  { href: "/admin/document-types", label: "Typy dokumentów", icon: <Shapes size={18} />, requires: "configureDocumentTypes" },
  { href: "/admin/workflows", label: "Ścieżki akceptacji", icon: <GitBranch size={18} />, requires: "configureWorkflows" },
  { href: "/admin/logs", label: "Logi systemowe", icon: <ScrollText size={18} />, requires: "viewSystemLogs" },
  { href: "/admin/config", label: "Konfiguracja", icon: <SlidersHorizontal size={18} />, requires: "manageConfig" }
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  // Karta dokumentu otwierana z różnych list nie należy do żadnej z nich.
  if (href === "/documents") return pathname === "/documents";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavGroup({ title, links, pathname, capabilities, taskCount }: { title?: string; links: NavLink[]; pathname: string; capabilities: Capabilities; taskCount: number }) {
  const visible = links.filter((link) => !link.requires || capabilities[link.requires]);
  if (!visible.length) return null;
  return (
    <div className="nav-group">
      {title && <span className="nav-title">{title}</span>}
      {visible.map((link) => (
        <Link key={link.href} href={link.href} className={isActive(pathname, link.href) ? "nav-item is-active" : "nav-item"} aria-current={isActive(pathname, link.href) ? "page" : undefined}>
          {link.icon}
          <span>{link.label}</span>
          {link.badge === "tasks" && taskCount > 0 && <span className="nav-badge" aria-label={`Do zrobienia: ${taskCount}`}>{taskCount}</span>}
        </Link>
      ))}
    </div>
  );
}

const SECRET_CLICKS = 7;
const SECRET_WINDOW_MS = 5_000;

/**
 * Numer wersji pod nazwą programu. Przez 2 dni po zmianie wersji z dopiskiem „Nowa wersja”.
 * To osobny przycisk, nie część linku do strony głównej: 7 kliknięć w ciągu 5 s otwiera ukrytą grę,
 * o ile administrator jej nie wyłączył (EASTER_EGG_ENABLED, sprawdzane przy każdym otwarciu).
 */
function BrandTitle() {
  const { data } = useVersionInfo();
  const [isNew, setIsNew] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const clicks = useRef<number[]>([]);
  const checking = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!data?.isNew) return;
    setIsNew(true);
    // Czas pozostały liczy serwer, więc zły zegar komputera nie wydłuża ani nie skraca dopisku.
    const timer = setTimeout(() => setIsNew(false), Math.min(data.newRemainingMs, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [data]);

  async function knock() {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((time) => now - time < SECRET_WINDOW_MS), now];
    if (clicks.current.length < SECRET_CLICKS || checking.current) return;
    clicks.current = [];
    checking.current = true;
    try {
      // Błąd odczytu = gra się nie otwiera; nic więcej się nie dzieje.
      const flag = await apiRequest<{ enabled: boolean }>("/config/easter-egg");
      if (flag.enabled) setGameOpen(true);
    } catch {
      // celowo cicho
    } finally {
      checking.current = false;
    }
  }

  function closeGame() {
    setGameOpen(false);
    buttonRef.current?.focus();
  }

  const details = [data?.commit && `Commit ${data.commit}`, data?.installedAt && `Zainstalowano ${dateTime(data.installedAt)}`].filter(Boolean).join(" · ");
  return (
    <div>
      {/* Numer wersji stoi przy nazwie programu; to on jest przyciskiem ukrytej gry (7 kliknięć). */}
      <div className="brand-title">
        <Link href="/" className="brand-name"><strong>Aprobis</strong></Link>
        {data?.version && (
          <button ref={buttonRef} type="button" className="brand-version version-button" title={details || undefined} onClick={knock}>v{data.version}</button>
        )}
      </div>
      {data?.version && (data.commit || isNew) && (
        <div className="version-line">
          {data.commit && <span>{data.commit}</span>}
          {isNew && <span className="version-new"><span className="version-dot" aria-hidden="true" />Nowa wersja</span>}
        </div>
      )}
      {gameOpen && <GameLauncher onClose={closeGame} />}
    </div>
  );
}

function NotificationBell() {
  const router = useRouter();
  const client = useQueryClient();
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function openItem(item: NotificationItem) {
    setOpen(false);
    if (!item.readAt) {
      await patch(`/notifications/${item.id}/read`).catch(() => undefined);
      await client.invalidateQueries({ queryKey: ["notifications"] });
    }
    if (item.documentId) router.push(`/documents/${item.documentId}`);
  }

  async function markAll() {
    await patch("/notifications/read-all").catch(() => undefined);
    await client.invalidateQueries({ queryKey: ["notifications"] });
  }

  return (
    <div className="menu-anchor" ref={panel}>
      <button type="button" className="icon-btn" aria-label={unread ? `Powiadomienia: ${unread} nowych` : "Powiadomienia"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Bell size={18} />
        {unread > 0 && <span className="dot-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="menu menu-wide">
          <div className="menu-head">
            <strong>Powiadomienia</strong>
            {unread > 0 && <button type="button" className="link-btn" onClick={markAll}>Oznacz wszystkie</button>}
          </div>
          {!data?.items.length && <p className="menu-empty">Nie masz żadnych powiadomień.</p>}
          <ul className="notification-list">
            {data?.items.map((item) => (
              <li key={item.id}>
                <button type="button" className={item.readAt ? "notification" : "notification is-unread"} onClick={() => openItem(item)}>
                  <strong>{item.title}</strong>
                  <span>{item.body}</span>
                  <small>{dateTime(item.createdAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const router = useRouter();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const name = fullName(me);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function logout() {
    await post("/auth/logout").catch(() => undefined);
    client.clear();
    router.replace("/login");
  }

  return (
    <div className="menu-anchor" ref={panel}>
      <button type="button" className="user-chip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="avatar" aria-hidden="true">{initials(name)}</span>
        <span className="user-chip-text">
          <strong>{name}</strong>
          <small>{me.roleLabel}</small>
        </span>
      </button>
      {open && (
        <div className="menu">
          <Link className="menu-item" href="/account" onClick={() => setOpen(false)}><Settings size={16} />Moje konto i zastępstwa</Link>
          <button type="button" className="menu-item" onClick={logout}><LogOut size={16} />Wyloguj</button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const { data: tasks } = useMyTasks();
  const ownWork = useDocuments({ scope: "created-by-me", status: "NEEDS_CORRECTION,DRAFT" }, 1);
  const [menuOpen, setMenuOpen] = useState(false);
  // Licznik mówi to samo co ekran „Do zrobienia”: decyzje, poprawki i niedokończone szkice.
  const taskCount = (tasks?.length ?? 0) + ownWork.total;

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  return (
    <div className="app">
      <aside className={menuOpen ? "sidebar is-open" : "sidebar"}>
        <div className="brand">
          <Link href="/" className="brand-mark" aria-hidden="true" tabIndex={-1}>A</Link>
          <BrandTitle />
        </div>
        <nav aria-label="Główna nawigacja">
          <NavGroup title="Moja praca" links={workLinks} pathname={pathname} capabilities={me.capabilities} taskCount={taskCount} />
          <NavGroup title="Dokumenty" links={documentLinks} pathname={pathname} capabilities={me.capabilities} taskCount={taskCount} />
          <NavGroup title="Kontrola" links={controlLinks} pathname={pathname} capabilities={me.capabilities} taskCount={taskCount} />
          <NavGroup title="Administracja" links={adminLinks} pathname={pathname} capabilities={me.capabilities} taskCount={taskCount} />
        </nav>
      </aside>
      {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-toggle" aria-label={menuOpen ? "Zamknij menu" : "Otwórz menu"} onClick={() => setMenuOpen((value) => !value)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="topbar-spacer" />
          {me.capabilities.createDocuments && (
            <Link href="/documents/new" className="btn btn-primary"><Plus size={16} /><span className="hide-small">Nowy dokument</span></Link>
          )}
          <NotificationBell />
          <UserMenu />
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
