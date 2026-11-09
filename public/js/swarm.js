// The house style in code: every person is a dot, every channel a swarm of
// them. This file draws the mark, the little swarm beside a channel name and
// the live flocks in the header and on the sign-in screen.

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;

function svg(width, height, dots, label) {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.setAttribute('width', width);
  el.setAttribute('height', height);
  el.setAttribute('fill', 'currentColor');
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  for (const [cx, cy, r] of dots) {
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', r);
    el.append(dot);
  }
  return el;
}

/** The mark: seven birds turning. */
export function mark(scale = 1) {
  const el = svg(28, 22, [
    [3.5, 3.5, 2.4], [8.6, 6.6, 2.2], [13.2, 10.4, 2.2], [18.4, 12, 2],
    [23, 9.8, 1.8], [21.2, 15.6, 1.7], [16.6, 18.6, 1.5],
  ]);
  el.setAttribute('width', 28 * scale);
  el.setAttribute('height', 22 * scale);
  el.classList.add('mark');
  return el;
}

// Where the nth bird of a small swarm sits. Filled from the middle out, so
// two people look like a pair and nine like a flock.
const SEATS = [[14, 8], [20, 8], [17, 3], [17, 13], [8, 8], [26, 8], [11, 13], [23, 3], [11, 3]];

/**
 * A channel's swarm: one dot per person online, up to nine.
 * Past that the number says it better, and the caller prints it.
 */
export function swarmGlyph(count) {
  const seats = SEATS.slice(0, Math.max(0, Math.min(count, SEATS.length)));
  const right = Math.max(0, ...seats.map(([x]) => x));
  const el = svg(30, 16, seats.map(([x, y]) => [x + (28 - right), y, 1.7]));
  el.classList.add('swarm-glyph');
  return el;
}

/** Roughly bell-shaped, between -1 and 1: most birds near the middle, a few far out. */
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;

/**
 * A flock of dots on a canvas.
 *
 * - `free`: a handful of birds wandering a band, one per person in the
 *   conversation. `pulse(id)` makes one swell when that person speaks.
 * - `ribbon`: hundreds of birds following a figure of eight, for the
 *   sign-in screen. They part around the pointer.
 */
export class Flock {
  constructor(canvas, { mode = 'free' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = mode;
    this.birds = [];
    this.pointer = null;
    this.running = false;
    this.frame = 0;
    this.last = 0;
    this.time = Math.random() * 100;
    this.still = matchMedia('(prefers-reduced-motion: reduce)');
    this.tick = this.tick.bind(this);

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.still.addEventListener('change', () => this.wake());
    document.addEventListener('visibilitychange', () => this.wake());
    this.resize();
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) {
      this.width = 0;
      return this.wake(); // hidden: nothing to draw, so stop flying
    }
    const grew = !this.width;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (grew) for (const bird of this.birds) this.place(bird);
    this.readColours();
    this.wake();
  }

  /** The colours come from the stylesheet, so the flock follows the theme. */
  readColours() {
    const style = getComputedStyle(this.canvas);
    this.ink = style.getPropertyValue('--text').trim() || '#000';
    this.accent = style.getPropertyValue('--accent').trim() || '#00f';
    this.draw();
  }

  place(bird) {
    bird.x = Math.random() * (this.width || 300);
    bird.y = Math.random() * (this.height || 60);
    const angle = Math.random() * TAU;
    bird.vx = Math.cos(angle) * 12;
    bird.vy = Math.sin(angle) * 6;
  }

  /**
   * Sets who is in the flock. Birds that stay keep flying where they were.
   * @param {Array<{id: string, self?: boolean}>} list
   */
  setBirds(list) {
    const old = new Map(this.birds.map((bird) => [bird.id, bird]));
    this.birds = list.map(({ id, self = false }) => {
      const bird = old.get(id) ?? { id, pulse: 0, lane: gauss() * 1.6, lead: gauss() * 1.5, size: 0.8 + Math.random() * 0.9, wander: Math.random() * TAU };
      if (!old.has(id)) this.place(bird);
      bird.self = self;
      return bird;
    });
    this.wake();
  }

  /** Fills the flock with anonymous birds, one of which is "you". */
  populate(count) {
    this.setBirds(Array.from({ length: count }, (_, i) => ({ id: `b${i}`, self: i === 0 })));
    // "You" fly near the middle of the ribbon, where the eye lands.
    Object.assign(this.birds[0], { lane: 0.15, lead: 0.1, size: 1.9 });
  }

  pulse(id) {
    const bird = this.birds.find((item) => item.id === id);
    if (!bird) return;
    bird.pulse = 1;
    this.wake();
  }

  setPointer(point) {
    this.pointer = point;
  }

  wake() {
    const visible = !document.hidden && this.width > 0 && this.canvas.offsetParent !== null && getComputedStyle(this.canvas).visibility !== 'hidden';
    if (this.still.matches || !visible) {
      this.running = false;
      cancelAnimationFrame(this.frame);
      // No motion wanted: settle the birds once and leave them be.
      if (visible) {
        for (let i = 0; i < 240; i += 1) this.step(1 / 30);
        this.draw();
      }
      return;
    }
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  tick(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  }

  step(dt) {
    this.time += dt;
    if (this.mode === 'ribbon') this.stepRibbon(dt);
    else this.stepFree(dt);
    for (const bird of this.birds) {
      bird.x += bird.vx * dt;
      bird.y += bird.vy * dt;
      if (bird.pulse > 0) bird.pulse = Math.max(0, bird.pulse - dt * 1.4);
    }
  }

  /**
   * A point on an upright figure of eight, `u` in turns, and the way it is
   * heading. Half of it reads as an S, which is what the flock covers.
   */
  path(u) {
    const a = u * TAU;
    const wide = this.width > 900;
    // Beside the form on a wide screen, across the whole band on a narrow one.
    const cx = this.width * (wide ? 0.66 : 0.5);
    const ax = this.width * (wide ? 0.2 : 0.34);
    const ay = this.height * (wide ? 0.4 : 0.3);
    return {
      x: cx + Math.sin(a * 2) * ax,
      y: this.height * 0.5 - Math.cos(a) * ay,
      dx: Math.cos(a * 2) * 2 * ax,
      dy: Math.sin(a) * ay,
    };
  }

  stepRibbon(dt) {
    const spread = Math.min(this.width, this.height) * 0.085;
    const head = this.time * 0.022;
    for (const bird of this.birds) {
      // Each bird has its own place in the ribbon: how far along, how far out.
      const p = this.path(head + bird.lead * 0.24);
      const length = Math.hypot(p.dx, p.dy) || 1;
      // The ribbon is thick in its middle and thins towards both ends.
      const taper = 0.35 + 1.1 * Math.exp(-bird.lead * bird.lead * 5);
      const breathe = 1 + 0.3 * Math.sin(this.time * 0.5 + bird.lead * 4);
      const out = bird.lane * spread * taper * breathe;
      const flutter = Math.sin(this.time * 1.3 + bird.wander) * 5;
      const tx = p.x + (-p.dy / length) * out + (p.dx / length) * flutter;
      const ty = p.y + (p.dx / length) * out + (p.dy / length) * flutter;
      bird.vx += (tx - bird.x) * 3 * dt;
      bird.vy += (ty - bird.y) * 3 * dt;
      if (this.pointer) {
        const dx = bird.x - this.pointer.x;
        const dy = bird.y - this.pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 130 * 130 && d2 > 1) {
          const push = (1 - Math.sqrt(d2) / 130) * 1100 * dt;
          bird.vx += (dx / Math.sqrt(d2)) * push;
          bird.vy += (dy / Math.sqrt(d2)) * push;
        }
      }
      const drag = Math.exp(-2 * dt);
      bird.vx *= drag;
      bird.vy *= drag;
    }
  }

  stepFree(dt) {
    const { birds, width, height } = this;
    const margin = 14;
    for (const bird of birds) {
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;
      let mvx = 0;
      let mvy = 0;
      let near = 0;
      for (const other of birds) {
        if (other === bird) continue;
        const dx = other.x - bird.x;
        const dy = other.y - bird.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 90 * 90) continue;
        near += 1;
        cx += dx;
        cy += dy;
        mvx += other.vx;
        mvy += other.vy;
        if (d2 < 16 * 16 && d2 > 0.01) {
          ax -= (dx / d2) * 220;
          ay -= (dy / d2) * 220;
        }
      }
      if (near) {
        ax += (cx / near) * 0.35 + (mvx / near - bird.vx) * 0.9;
        ay += (cy / near) * 0.35 + (mvy / near - bird.vy) * 0.9;
      }
      // A slow turn of its own keeps a lone bird from flying in a straight line.
      bird.wander += (Math.random() - 0.5) * 2.4 * dt;
      ax += Math.cos(bird.wander) * 14;
      ay += Math.sin(bird.wander) * 9;
      if (bird.x < margin) ax += (margin - bird.x) * 6;
      if (bird.x > width - margin) ax -= (bird.x - (width - margin)) * 6;
      if (bird.y < margin) ay += (margin - bird.y) * 9;
      if (bird.y > height - margin) ay -= (bird.y - (height - margin)) * 9;
      bird.vx += ax * dt;
      bird.vy += ay * dt;
      const speed = Math.hypot(bird.vx, bird.vy) || 1;
      const wanted = Math.max(10, Math.min(speed, 26));
      bird.vx = (bird.vx / speed) * wanted;
      bird.vy = (bird.vy / speed) * wanted * (height < 90 ? 0.94 : 1);
    }
  }

  draw() {
    const { ctx, width, height } = this;
    if (!width) return;
    ctx.clearRect(0, 0, width, height);
    const base = this.mode === 'ribbon' ? 1.1 : 2.6;
    let self = null;
    ctx.fillStyle = this.ink;
    ctx.beginPath();
    for (const bird of this.birds) {
      if (bird.self) {
        self = bird;
        continue;
      }
      const r = base * (this.mode === 'ribbon' ? bird.size : 1) * (1 + bird.pulse * 1.2);
      ctx.moveTo(bird.x + r, bird.y);
      ctx.arc(bird.x, bird.y, r, 0, TAU);
    }
    ctx.fill();
    if (self) {
      const r = (this.mode === 'ribbon' ? 4.5 : base + 0.4) * (1 + self.pulse * 1.2);
      ctx.fillStyle = this.accent;
      ctx.beginPath();
      ctx.arc(self.x, self.y, r, 0, TAU);
      ctx.fill();
    }
  }
}
