"use client";

import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { Component, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Okno ukrytej gry, montowane z menu dopiero po jej odkryciu. Samo okno (Zamknij, ESC, fokus, blokada
 * przewijania) jest w tym lekkim pliku, więc działa także w trakcie pobierania gry i po jej błędzie.
 * Kod gry (SpaceGame) pobiera się dopiero teraz; zamknięcie okna w trakcie pobierania kończy sprawę,
 * bo późno doczytany moduł nie ma już gdzie się wyrenderować.
 * Okno nie zmienia adresu i nie odmontowuje niczego pod spodem, więc niezapisany formularz zostaje nietknięty.
 */
const SpaceGame = dynamic(() => import("./SpaceGame"), {
  ssr: false,
  loading: () => <div className="modal-body">Ładowanie gry…</div>
});

class GameErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="modal-body" role="alert">Gra się nie uruchomiła. Twoja praca jest nietknięta.</div>;
  }
}

function GameWindow({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Najnowszy onClose bez ponownego uruchamiania efektu (inaczej każde odświeżenie menu kradłoby fokus).
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Fokus od razu w oknie; gdy gra się wczyta, przejmie go jej przycisk Start.
    closeRef.current?.focus();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeHandler.current();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      document.body.style.overflow = previous;
    };
  }, []);

  // Tab krąży wewnątrz okna.
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop game-backdrop">
      <div ref={dialogRef} className="modal game-dialog" role="dialog" aria-modal="true" aria-labelledby="game-title" onKeyDown={trapFocus}>
        <div className="modal-head game-head">
          <h2 id="game-title">Kosmiczny obieg</h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}><X size={16} />Zamknij</button>
        </div>
        <GameErrorBoundary>
          <SpaceGame onClose={onClose} />
        </GameErrorBoundary>
      </div>
    </div>
  );
}

/** Portal do body: menu boczne na telefonie jest przesuwane transformacją, która psułaby position: fixed okna. */
export function GameLauncher({ onClose }: { onClose: () => void }) {
  return createPortal(<GameWindow onClose={onClose} />, document.body);
}
