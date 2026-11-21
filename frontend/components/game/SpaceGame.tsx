"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * „Kosmiczny obieg” — ukryta gra (7 kliknięć w numer wersji w menu).
 * Działa wyłącznie w przeglądarce: bez zapytań do API, bez danych dokumentów; rekord tylko w localStorage.
 * Logika w jednym obiekcie poza Reactem (pętla requestAnimationFrame), React rysuje tylko HUD i ekrany.
 */

const W = 480;
const H = 640;
const PLAYER_Y = 596;
const RECORD_KEY = "aprobis-space-game-record";
const MAX_BULLETS = 40;
const MAX_PARTICLES = 160;

type Phase = "intro" | "playing" | "paused" | "wave" | "over";
type Bonus = "Z" | "D";

type Enemy = { col: number; row: number; kind: 0 | 1 | 2; alive: boolean };
type Shot = { x: number; y: number; vy: number; enemy: boolean };
type Drop = { x: number; y: number; bonus: Bonus };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
type Block = { x: number; y: number; hp: number };
type Star = { x: number; y: number; speed: number; size: number };

type Hud = { score: number; lives: number; wave: number; record: number; bonus: string | null };

const ENEMY_COLORS = ["#7dd3fc", "#c4b5fd", "#fca5a5"];
const ENEMY_POINTS = [10, 20, 30];
const COLS = 8;
const ROWS = 4;
const CELL_X = 44;
const CELL_Y = 38;

function readRecord() {
  try {
    const value = Number(window.localStorage.getItem(RECORD_KEY));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function saveRecord(value: number) {
  try {
    window.localStorage.setItem(RECORD_KEY, String(value));
  } catch {
    // Brak localStorage (tryb prywatny, blokada): rekord żyje tylko do zamknięcia gry.
  }
}

function makeShields(): Block[] {
  const blocks: Block[] = [];
  const size = 8;
  for (let s = 0; s < 3; s += 1) {
    const left = 72 + s * 128;
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        // Ścięte górne rogi i wycięcie od spodu: osłona wygląda jak łuk.
        if (r === 0 && (c === 0 || c === 7)) continue;
        if (r === 2 && c >= 3 && c <= 4) continue;
        blocks.push({ x: left + c * size, y: 520 + r * size, hp: 3 });
      }
    }
  }
  return blocks;
}

function makeStars(): Star[] {
  return Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H, speed: 8 + Math.random() * 30, size: Math.random() < 0.2 ? 2 : 1 }));
}

function createWorld(record: number) {
  return {
    phase: "intro" as Phase,
    score: 0,
    lives: 3,
    wave: 1,
    record,
    playerX: W / 2,
    cooldown: 0,
    invulnerable: 0,
    doubleShot: 0,
    calm: 0,
    enemies: [] as Enemy[],
    formationX: 0,
    formationY: 0,
    direction: 1,
    enemyFire: 1.2,
    shots: [] as Shot[],
    drops: [] as Drop[],
    particles: [] as Particle[],
    shields: makeShields(),
    stars: makeStars(),
    waveTimer: 0
  };
}

type World = ReturnType<typeof createWorld>;

function startWave(world: World) {
  world.enemies = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      world.enemies.push({ col, row, kind: (row === 0 ? 2 : row === 1 ? 1 : 0) as 0 | 1 | 2, alive: true });
    }
  }
  world.formationX = (W - (COLS - 1) * CELL_X) / 2;
  world.formationY = 70 + Math.min(world.wave - 1, 5) * 10;
  world.direction = 1;
  world.shots = world.shots.filter((shot) => !shot.enemy);
  world.enemyFire = 1.2;
}

function enemyPosition(world: World, enemy: Enemy) {
  return { x: world.formationX + enemy.col * CELL_X, y: world.formationY + enemy.row * CELL_Y };
}

export default function SpaceGame({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const input = useRef({ left: false, right: false, fire: false });
  const reducedMotion = useRef(false);
  const [phase, setPhase] = useState<Phase>("intro");
  const [hud, setHud] = useState<Hud>({ score: 0, lives: 3, wave: 1, record: 0, bonus: null });
  const [newRecord, setNewRecord] = useState(false);

  if (!worldRef.current && typeof window !== "undefined") worldRef.current = createWorld(readRecord());

  const syncPhase = useCallback((next: Phase) => {
    const world = worldRef.current!;
    world.phase = next;
    setPhase(next);
  }, []);

  const releaseInput = useCallback(() => {
    input.current = { left: false, right: false, fire: false };
  }, []);

  const start = useCallback(() => {
    const record = worldRef.current?.record ?? readRecord();
    const world = createWorld(record);
    worldRef.current = world;
    startWave(world);
    setNewRecord(false);
    releaseInput();
    syncPhase("playing");
    stageRef.current?.focus();
  }, [releaseInput, syncPhase]);

  const pause = useCallback(() => {
    if (worldRef.current?.phase === "playing" || worldRef.current?.phase === "wave") {
      releaseInput();
      syncPhase("paused");
    }
  }, [releaseInput, syncPhase]);

  const resume = useCallback(() => {
    if (worldRef.current?.phase !== "paused") return;
    releaseInput();
    syncPhase(worldRef.current.enemies.some((enemy) => enemy.alive) ? "playing" : "wave");
    stageRef.current?.focus();
  }, [releaseInput, syncPhase]);

  // Klawiatura: tylko w otwartej grze; klawisze gry nie przewijają strony i nie klikają przycisków pod spodem.
  useEffect(() => {
    const keyOf = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") return "left";
      if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") return "right";
      if (event.key === " " || event.key === "ArrowUp") return "fire";
      return null;
    };
    // Fokus na przycisku, linku albo polu: klawisz robi to, co zwykle (Spacja klika „Zamknij”/„Pauza”).
    const nativeTarget = (event: KeyboardEvent) =>
      event.target instanceof HTMLElement && event.target.closest("button, a, input, select, textarea, [contenteditable]") !== null;
    const down = (event: KeyboardEvent) => {
      const world = worldRef.current;
      if (!world || nativeTarget(event)) return;
      if ((event.key === "p" || event.key === "P") && (world.phase === "playing" || world.phase === "wave")) {
        pause();
        return;
      }
      const key = keyOf(event);
      if (!key || (world.phase !== "playing" && world.phase !== "wave")) return;
      event.preventDefault();
      input.current[key] = true;
    };
    const up = (event: KeyboardEvent) => {
      const key = keyOf(event);
      if (key) input.current[key] = false;
    };
    const hidden = () => { if (document.hidden) pause(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [pause]);

  // Pętla gry: jedna na cały czas życia komponentu, anulowana przy zamknięciu.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = motionQuery.matches;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    let last = performance.now();
    let lastHud = "";

    const burst = (x: number, y: number, color: string, count: number) => {
      const world = worldRef.current!;
      if (reducedMotion.current) return;
      for (let i = 0; i < count && world.particles.length < MAX_PARTICLES; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 120;
        world.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.5 + Math.random() * 0.4, color });
      }
    };

    const hitPlayer = (world: World) => {
      if (world.invulnerable > 0) return;
      world.lives -= 1;
      world.invulnerable = 2;
      world.doubleShot = 0;
      burst(world.playerX, PLAYER_Y, "#fde68a", 30);
      if (world.lives <= 0) gameOver(world);
    };

    const gameOver = (world: World) => {
      world.lives = Math.max(0, world.lives);
      if (world.score > world.record) {
        world.record = world.score;
        saveRecord(world.score);
        setNewRecord(true);
      }
      releaseInput();
      syncPhase("over");
    };

    const update = (world: World, dt: number) => {
      for (const star of world.stars) {
        if (reducedMotion.current) break;
        star.y += star.speed * dt;
        if (star.y > H) { star.y = 0; star.x = Math.random() * W; }
      }
      for (const particle of world.particles) {
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.life -= dt;
      }
      world.particles = world.particles.filter((particle) => particle.life > 0);

      if (world.phase === "wave") {
        world.waveTimer -= dt;
        if (world.waveTimer <= 0) {
          startWave(world);
          syncPhase("playing");
        }
        return;
      }
      if (world.phase !== "playing") return;

      world.invulnerable = Math.max(0, world.invulnerable - dt);
      world.doubleShot = Math.max(0, world.doubleShot - dt);
      world.calm = Math.max(0, world.calm - dt);
      world.cooldown = Math.max(0, world.cooldown - dt);

      // Gracz.
      const move = (input.current.right ? 1 : 0) - (input.current.left ? 1 : 0);
      world.playerX = Math.min(W - 24, Math.max(24, world.playerX + move * 260 * dt));
      const ownShots = world.shots.filter((shot) => !shot.enemy).length;
      if (input.current.fire && world.cooldown <= 0 && ownShots < (world.doubleShot > 0 ? 6 : 3)) {
        world.cooldown = 0.3;
        if (world.doubleShot > 0) {
          world.shots.push({ x: world.playerX - 9, y: PLAYER_Y - 14, vy: -480, enemy: false }, { x: world.playerX + 9, y: PLAYER_Y - 14, vy: -480, enemy: false });
        } else {
          world.shots.push({ x: world.playerX, y: PLAYER_Y - 16, vy: -480, enemy: false });
        }
      }

      // Formacja: szybsza z każdą falą i z każdym zestrzelonym.
      const alive = world.enemies.filter((enemy) => enemy.alive);
      const speed = (26 + world.wave * 6) * (1 + (1 - alive.length / (COLS * ROWS)) * 2.2);
      world.formationX += world.direction * speed * dt;
      const xs = alive.map((enemy) => enemyPosition(world, enemy).x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      if ((world.direction > 0 && maxX > W - 22) || (world.direction < 0 && minX < 22)) {
        world.direction *= -1;
        world.formationX += world.direction * 4;
        world.formationY += 16;
      }
      const lowest = Math.max(...alive.map((enemy) => enemyPosition(world, enemy).y));
      if (lowest >= PLAYER_Y - 24) {
        world.lives = 0;
        gameOver(world);
        return;
      }
      // Formacja zjeżdżająca na osłony zjada je.
      world.shields = world.shields.filter((block) => block.y > lowest + 12);

      // Ogień przeciwnika: z najniższego w losowej kolumnie.
      world.enemyFire -= dt;
      if (world.enemyFire <= 0) {
        world.enemyFire = Math.max(0.35, 1.3 - world.wave * 0.1) * (0.6 + Math.random() * 0.8);
        if (world.calm <= 0 && world.shots.length < MAX_BULLETS) {
          const columns = [...new Set(alive.map((enemy) => enemy.col))];
          const col = columns[Math.floor(Math.random() * columns.length)];
          const shooter = alive.filter((enemy) => enemy.col === col).sort((a, b) => b.row - a.row)[0];
          if (shooter) {
            const position = enemyPosition(world, shooter);
            world.shots.push({ x: position.x, y: position.y + 12, vy: 170 + world.wave * 12, enemy: true });
          }
        }
      }

      // Pociski.
      for (const shot of world.shots) shot.y += shot.vy * dt;
      world.shots = world.shots.filter((shot) => shot.y > -10 && shot.y < H + 10);

      const removed = new Set<Shot>();
      for (const shot of world.shots) {
        // Osłony zatrzymują pociski obu stron.
        const block = world.shields.find((item) => shot.x >= item.x - 1 && shot.x <= item.x + 9 && shot.y >= item.y && shot.y <= item.y + 8);
        if (block) {
          block.hp -= 1;
          removed.add(shot);
          continue;
        }
        if (shot.enemy) {
          if (Math.abs(shot.x - world.playerX) < 18 && Math.abs(shot.y - PLAYER_Y) < 12) {
            removed.add(shot);
            hitPlayer(world);
            if (world.phase !== "playing") return;
          }
          continue;
        }
        for (const enemy of alive) {
          if (!enemy.alive) continue;
          const position = enemyPosition(world, enemy);
          if (Math.abs(shot.x - position.x) < 15 && Math.abs(shot.y - position.y) < 12) {
            enemy.alive = false;
            removed.add(shot);
            world.score += ENEMY_POINTS[enemy.kind] * Math.min(world.wave, 5);
            burst(position.x, position.y, ENEMY_COLORS[enemy.kind], 14);
            if (Math.random() < 0.07) world.drops.push({ x: position.x, y: position.y, bonus: Math.random() < 0.5 ? "Z" : "D" });
            break;
          }
        }
      }
      world.shots = world.shots.filter((shot) => !removed.has(shot));
      world.shields = world.shields.filter((block) => block.hp > 0);

      // Bonusy.
      for (const drop of world.drops) drop.y += 110 * dt;
      for (const drop of world.drops) {
        if (Math.abs(drop.x - world.playerX) < 22 && Math.abs(drop.y - PLAYER_Y) < 16) {
          drop.y = H + 100;
          if (drop.bonus === "Z") {
            world.doubleShot = 10;
          } else {
            world.shots = world.shots.filter((shot) => !shot.enemy);
            world.calm = 3;
          }
          world.score += 50;
        }
      }
      world.drops = world.drops.filter((drop) => drop.y < H + 20);

      if (!world.enemies.some((enemy) => enemy.alive)) {
        world.wave += 1;
        world.waveTimer = 1.6;
        world.score += 100;
        syncPhase("wave");
      }
    };

    const drawShip = (x: number, y: number) => {
      context.save();
      context.translate(x, y);
      context.fillStyle = "#38bdf8";
      context.beginPath();
      context.moveTo(0, -16);
      context.lineTo(7, -4);
      context.lineTo(18, 6);
      context.lineTo(18, 11);
      context.lineTo(6, 8);
      context.lineTo(0, 12);
      context.lineTo(-6, 8);
      context.lineTo(-18, 11);
      context.lineTo(-18, 6);
      context.lineTo(-7, -4);
      context.closePath();
      context.fill();
      context.fillStyle = "#e0f2fe";
      context.beginPath();
      context.ellipse(0, -3, 3, 6, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };

    // Przeciwnicy: geometryczne „blokady transmisji” (romb, sześciokąt, gwiazda).
    const drawEnemy = (x: number, y: number, kind: number, time: number) => {
      context.save();
      context.translate(x, y);
      context.fillStyle = ENEMY_COLORS[kind];
      context.strokeStyle = "rgba(255,255,255,.55)";
      context.lineWidth = 1.5;
      context.beginPath();
      const pulse = reducedMotion.current ? 1 : 1 + Math.sin(time * 4 + x * 0.05) * 0.06;
      if (kind === 0) {
        context.moveTo(0, -11 * pulse); context.lineTo(13, 0); context.lineTo(0, 11 * pulse); context.lineTo(-13, 0);
      } else if (kind === 1) {
        for (let i = 0; i < 6; i += 1) {
          const angle = Math.PI / 6 + (i * Math.PI) / 3;
          context.lineTo(Math.cos(angle) * 13 * pulse, Math.sin(angle) * 11 * pulse);
        }
      } else {
        for (let i = 0; i < 10; i += 1) {
          const radius = i % 2 === 0 ? 14 * pulse : 6;
          const angle = -Math.PI / 2 + (i * Math.PI) / 5;
          context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
        }
      }
      context.closePath();
      context.fill();
      context.stroke();
      context.fillStyle = "#0b1020";
      context.fillRect(-4, -2, 3, 3);
      context.fillRect(1, -2, 3, 3);
      context.restore();
    };

    const draw = (world: World, time: number) => {
      context.fillStyle = "#0b1020";
      context.fillRect(0, 0, W, H);
      for (const star of world.stars) {
        context.fillStyle = star.size > 1 ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.4)";
        context.fillRect(star.x, star.y, star.size, star.size);
      }
      if (world.phase === "intro") return;

      for (const block of world.shields) {
        context.fillStyle = block.hp === 3 ? "#34d399" : block.hp === 2 ? "#10b981" : "#047857";
        context.fillRect(block.x, block.y, 8, 8);
      }
      for (const enemy of world.enemies) {
        if (!enemy.alive) continue;
        const position = enemyPosition(world, enemy);
        drawEnemy(position.x, position.y, enemy.kind, time);
      }
      for (const shot of world.shots) {
        context.fillStyle = shot.enemy ? "#fb7185" : world.doubleShot > 0 ? "#fde047" : "#e0f2fe";
        context.fillRect(shot.x - 1.5, shot.y - 6, 3, 12);
      }
      for (const drop of world.drops) {
        context.fillStyle = drop.bonus === "Z" ? "#fde047" : "#34d399";
        context.beginPath();
        context.arc(drop.x, drop.y, 10, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#0b1020";
        context.font = "bold 12px system-ui, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(drop.bonus, drop.x, drop.y + 1);
      }
      for (const particle of world.particles) {
        context.globalAlpha = Math.max(0, Math.min(1, particle.life * 2));
        context.fillStyle = particle.color;
        context.fillRect(particle.x, particle.y, 2, 2);
      }
      context.globalAlpha = 1;
      // Po trafieniu statek przygasa (bez migania: stała przezroczystość).
      if (world.phase !== "over") {
        context.globalAlpha = world.invulnerable > 0 ? 0.4 : 1;
        drawShip(world.playerX, PLAYER_Y);
        context.globalAlpha = 1;
      }
    };

    const tick = (now: number) => {
      const world = worldRef.current;
      // Krok ograniczony: po przerwie (inna karta, debugger) gra nie „przeskakuje”.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (world) {
        update(world, dt);
        draw(world, now / 1000);
        const bonus = world.doubleShot > 0 ? `Zastępstwo ${Math.ceil(world.doubleShot)} s` : world.calm > 0 ? `Drożny obieg ${Math.ceil(world.calm)} s` : null;
        const next = `${world.score}|${world.lives}|${world.wave}|${world.record}|${bonus}`;
        if (next !== lastHud) {
          lastHud = next;
          setHud({ score: world.score, lives: world.lives, wave: world.wave, record: world.record, bonus });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [releaseInput, syncPhase]);

  // Przyciski dotykowe: przytrzymanie = ruch/ogień, puszczenie albo zjechanie palcem = stop.
  const hold = (key: "left" | "right" | "fire") => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      input.current[key] = true;
    },
    onPointerUp: () => { input.current[key] = false; },
    onPointerCancel: () => { input.current[key] = false; },
    onLostPointerCapture: () => { input.current[key] = false; },
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault()
  });

  const playing = phase === "playing" || phase === "wave";

  return (
    <div className="game">
      <div className="game-hud" aria-live="off">
        <span>Wynik <strong>{hud.score}</strong></span>
        <span>Fala <strong>{hud.wave}</strong></span>
        <span>Życia <strong>{"▲".repeat(Math.max(0, hud.lives)) || "–"}</strong></span>
        <span>Rekord <strong>{hud.record}</strong></span>
        {hud.bonus && <span className="game-bonus">{hud.bonus}</span>}
        {playing && <button type="button" className="btn game-pause" onClick={pause}>Pauza</button>}
      </div>
      <div className="game-stage" ref={stageRef} tabIndex={-1}>
        <canvas ref={canvasRef} className="game-canvas" aria-label="Plansza gry Kosmiczny obieg" role="img" />
        {phase === "intro" && (
          <div className="game-overlay">
            <h3>Kosmiczny obieg</h3>
            <p>Blokady transmisji zatykają kanał. Udrożnij obieg, zanim zejdą na Twoją orbitę.</p>
            <ul>
              <li><kbd>←</kbd> <kbd>→</kbd> albo <kbd>A</kbd> <kbd>D</kbd> — lot</li>
              <li><kbd>Spacja</kbd> — strzał (przytrzymaj)</li>
              <li><kbd>P</kbd> — pauza, <kbd>Esc</kbd> — wyjście</li>
              <li><strong className="game-z">Z</strong> Zastępstwo: drugi promień · <strong className="game-d">D</strong> Drożny obieg: czysty tor</li>
            </ul>
            <button type="button" className="btn btn-primary" onClick={start} autoFocus>Start</button>
          </div>
        )}
        {phase === "paused" && (
          <div className="game-overlay">
            <h3>Pauza</h3>
            <p>Praca pod spodem czeka nietknięta.</p>
            <button type="button" className="btn btn-primary" onClick={resume} autoFocus>Wznów</button>
          </div>
        )}
        {phase === "wave" && <div className="game-banner" aria-live="polite">Fala {hud.wave}</div>}
        {phase === "over" && (
          <div className="game-overlay">
            <h3>Transmisja zakończona</h3>
            <p>Wynik: <strong>{hud.score}</strong> · fala {hud.wave}</p>
            {newRecord ? <p className="game-record">Nowy rekord!</p> : <p className="muted-light">Rekord: {hud.record}</p>}
            <div className="game-actions">
              <button type="button" className="btn btn-primary" onClick={start} autoFocus>Jeszcze raz</button>
              <button type="button" className="btn" onClick={onClose}>Wróć do pracy</button>
            </div>
          </div>
        )}
      </div>
      <div className="game-touch" aria-hidden={!playing}>
        <button type="button" className="btn" aria-label="W lewo" disabled={!playing} {...hold("left")}>◀</button>
        <button type="button" className="btn btn-primary game-fire" disabled={!playing} {...hold("fire")}>Strzał</button>
        <button type="button" className="btn" aria-label="W prawo" disabled={!playing} {...hold("right")}>▶</button>
      </div>
    </div>
  );
}
