'use strict';
/**
 * The head-up display side of Warm-Up HUD.
 *
 * One image layer on cluster-render's 'hud' target. The target is an 800x480 scene; only
 * HUD_WINDOW of it is actually visible through the windshield, so the readout is placed inside
 * that. A picture, never a shader: the cluster's renderer runs the HUD's shaders and a heavy one
 * has restarted the cluster on car (see redline/hud.js).
 *
 * Night maps and HUD reflection both want near-black backgrounds - anything not drawn stays
 * transparent glass, so we draw glyphs and a bar, nothing else.
 */
const { Canvas } = require('./kit/canvas');
const { HudClaim } = require('./kit/hud_claim');

let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* reported by start() */ }

const SCENE_W = 800, SCENE_H = 480;
/* the part of the scene the driver actually sees - measured on THIS car from Screen Lab photos
 * (top/bottom/left match bimmer-lab's 120,100 485x278; the right edge reaches ~690, not 605) */
const HUD_WINDOW = { x: 120, y: 100, w: 570, h: 278 };
/* BMW's own HUD content, seen in the same photos (scene px, approximate):
 *   every view: speed limit + speed, bottom-left  x 120-340, y 318-378
 *   M view:     rev band across the top           x 120-690, y 105-182
 *               its diagonal down the left        x 120-215, y 105-245
 * SLOT is what is left clear in every view, so placement needs no idea which view is on. */
const SLOT = { x: 220, y: 185, w: 470, h: 133 };
const IW = 400, IH = 120;
const FPS = 5;                       /* warm-up moves slowly; no reason to burn cluster bandwidth */

const COLD = '#ff9d3b', WARM = '#ffd34d', READY = '#2fd27a', DIM = '#8a8a8a', TEXT = '#ffffff';

function state(oil, readyAt) {
    if (typeof oil !== 'number' || !isFinite(oil)) return { key: 'none', label: 'OIL --', colour: DIM, frac: 0 };
    if (oil < 50) return { key: 'cold', label: 'COLD', colour: COLD, frac: Math.max(0, (oil + 10) / (readyAt + 10)) };
    if (oil < readyAt) return { key: 'warm', label: 'WARMING', colour: WARM, frac: (oil + 10) / (readyAt + 10) };
    return { key: 'ready', label: 'READY', colour: READY, frac: 1 };
}

/** A safe ceiling while the oil is cold - deliberately conservative, not a BMW figure. */
function revCeiling(oil, readyAt) {
    if (typeof oil !== 'number' || !isFinite(oil)) return null;
    if (oil >= readyAt) return null;
    if (oil < 30) return 3000;
    if (oil < 50) return 4000;
    if (oil < 70) return 5000;
    return 6000;
}

function draw(cv, d, opts) {
    cv.clear('#000000');                       /* black reads as transparent glass on a HUD */
    const st = state(d.oil, opts.readyAt);
    const unitF = opts.tempUnit === 'f';
    const t = (typeof d.oil === 'number' && isFinite(d.oil)) ? (unitF ? d.oil * 9 / 5 + 32 : d.oil) : null;

    cv.text('OIL', 8, 34, 22, DIM, { font: 'bold' });
    cv.text(t === null ? '--' : Math.round(t) + (unitF ? 'F' : 'C'), 70, 40, 44, st.colour, { font: 'bold' });
    cv.text(st.label, IW - 8, 36, 26, st.colour, { font: 'bold', align: 'right' });

    /* progress bar */
    const bx = 8, by = 58, bw = IW - 16, bh = 12;
    cv.roundRect(bx, by, bw, bh, 6, '#2a2a2a');
    if (st.frac > 0) cv.roundRect(bx, by, Math.max(bh, Math.min(1, st.frac) * bw), bh, 6, st.colour);

    const ceil = revCeiling(d.oil, opts.readyAt);
    if (ceil !== null) {
        cv.text('keep under ' + ceil + ' rpm', 8, 100, 24, WARM);
    } else if (st.key === 'ready') {
        cv.text('full revs available', 8, 100, 24, READY);
    } else {
        cv.text('waiting for the engine', 8, 100, 24, DIM);
    }

    if (typeof d.coolant === 'number' && isFinite(d.coolant)) {
        const c = unitF ? d.coolant * 9 / 5 + 32 : d.coolant;
        cv.text('H2O ' + Math.round(c) + (unitF ? 'F' : 'C'), IW - 8, 100, 22, TEXT, { align: 'right' });
    }
    return st;
}

class WarmHud {
    constructor(ctx, id) {
        this.ctx = ctx; this.log = ctx.log; this.id = id;
        this.cr = null; this.layer = null; this.claim = new HudClaim(id, ctx.log);
        this.readySince = 0; this.lastKey = '';
        /* done = warm-up is over for this drive: the HUD stays off until the oil is properly cold again.
         * firstOil = the first real oil reading, to spot a restart of an already-warm engine. */
        this.done = false; this.firstOil = null;
    }

    available() { return !!ClusterRender; }

    start() {
        if (!ClusterRender) { this.log.warn('hud: cluster_render_client missing - is cluster-render installed?'); return false; }
        this.cr = new ClusterRender(this.id);
        this.cr.on('layer', (ref, s, why) => this.log.info('hud layer: ' + s + (why ? ' (' + why + ')' : '')));
        this.cr.on('target', (name, s, holder, why, guideDisabled, disabled) => {
            if (name === 'hud' && disabled) this.log.warn('hud: target disabled by the guard - run `cluster-render guard-reset` as root');
        });
        this.cr.on('ready', () => { this.lastKey = ''; });
        this.cr.connect();
        return true;
    }

    /** size and vertical position from settings, kept inside SLOT (clear of BMW's content in every view) */
    _rect() {
        let s = (Number(this.ctx.settings.get('scale')) || 100) / 100;
        s = Math.min(s, SLOT.w / IW, SLOT.h / IH);               /* never larger than the clear slot */
        const w = Math.round(IW * s), h = Math.round(IH * s);
        let y = Number(this.ctx.settings.get('posY'));
        if (!isFinite(y)) y = SLOT.y;
        y = Math.max(SLOT.y, Math.min(y, SLOT.y + SLOT.h - h));
        return { x: SLOT.x, y: y, w: w, h: h };
    }

    off() {
        if (this.layer && this.cr) { this.cr.drop(this.layer); }
        this.layer = null; this.claim.hold(false); this.lastKey = '';
    }

    update(d) {
        if (!this.cr) return null;
        const on = this.ctx.settings.get('hud') !== false;
        /* standing app: say we are here and on, and give way while another app (Redline) holds
         * the HUD. Without this we would both draw and the last writer would win. */
        try {
            HudClaim.standing(this.id, on);
            if (on && HudClaim.others(this.id).length) { if (this.layer) this.off(); return state(d.oil, Number(this.ctx.settings.get('readyAt')) || 90); }
        } catch (e) { /* claims live on tmpfs; if they cannot be read, just carry on */ }
        const opts = { readyAt: Number(this.ctx.settings.get('readyAt')) || 90, tempUnit: this.ctx.settings.get('tempUnit') };
        const st = state(d.oil, opts.readyAt);

        const hideAfter = Number(this.ctx.settings.get('hideWhenReady')) || 0;
        const haveOil = typeof d.oil === 'number' && isFinite(d.oil);

        if (haveOil && this.firstOil === null) {
            this.firstOil = d.oil;
            /* engine already warm when the car came on (a quick stop): nothing to warm up, never show */
            if (hideAfter > 0 && d.oil >= opts.readyAt) { this.done = true; this.ctx.log.info('hud: engine already warm, staying off this drive'); }
        }
        /* re-arm only when the oil has gone properly cold again - 20 C under ready - so hovering
         * around the threshold cannot flick it back on */
        if (this.done && haveOil && d.oil < opts.readyAt - 20) { this.done = false; this.readySince = 0; this.ctx.log.info('hud: oil cold again, warm-up shown again'); }

        /* the countdown starts at ready and only restarts if the oil falls properly back (5 C under
         * ready): oil idling at 89-92 C would otherwise reset it on every dip and never turn off */
        if (!this.done && haveOil) {
            if (d.oil >= opts.readyAt) { if (!this.readySince) this.readySince = Date.now(); }
            else if (d.oil < opts.readyAt - 5) this.readySince = 0;
            if (hideAfter > 0 && this.readySince && (Date.now() - this.readySince) / 1000 >= hideAfter) {
                this.done = true; this.ctx.log.info('hud: warm, hidden for the rest of this drive');
            }
        }

        /* nothing to say until the first oil reading: no "OIL --" on the windshield */
        if (!on || this.done || !haveOil) { if (this.layer) this.off(); return st; }

        const r = this._rect();
        if (!this.layer) {
            this.layer = this.cr.image({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h,
                iw: IW, ih: IH, fps: FPS, sampling: 'bilinear' });
            if (!this.layer) { this.log.warn('hud: layer refused'); return st; }
            this.claim.hold(true);
        } else {
            this.cr.set(this.layer, r);
        }

        /* only redraw when something a driver would notice changed */
        const key = st.key + '|' + (typeof d.oil === 'number' ? Math.round(d.oil) : 'x') +
            '|' + (typeof d.coolant === 'number' ? Math.round(d.coolant) : 'x') + '|' + opts.tempUnit;
        if (key === this.lastKey) return st;
        this.lastKey = key;

        const cv = new Canvas(IW, IH);
        draw(cv, d, opts);
        if (!this.cr.pixels(this.layer, null, Buffer.from(cv.d.buffer || cv.d))) this.log.warn('hud: pixels refused');
        return st;
    }

    stop() { this.off(); if (this.cr) { try { this.cr.close(); } catch (e) { /* going away anyway */ } } }
}

module.exports = { WarmHud: WarmHud, state: state, revCeiling: revCeiling, HUD_WINDOW: HUD_WINDOW, SLOT: SLOT };
