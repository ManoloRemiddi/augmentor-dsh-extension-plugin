// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — page-context action helpers (extension/dom-actions.js).
 *
 * F2 (audit): the click/type handlers in sw.js used to carry duplicated
 * stringified copies of these three helpers (humanName / pulse / ripple)
 * inside their inject() closures. They now live here, as a classic content
 * script file that sw.js injects FIRST (chrome.scripting cannot mix files +
 * func in one call) and exposes on globalThis.__dshAugDom. Re-injection is
 * idempotent: it just re-binds the globals for the current document.
 *
 * Runs in the ISOLATED world (like the inject() funcs), so the SW's page
 * closures can read globalThis.__dshAugDom directly. The accent color is
 * passed in per call (sw.js computes it from theme-tokens.js) — this file
 * deliberately knows nothing about the palette.
 */
(() => {
  'use strict'

  /**
   * A human-readable name for the element the agent just touched, for the
   * action result + the on-page overlay line ("clicked Save").
   * Priority: visible text → aria-label → placeholder → tag fallback.
   */
  function humanName(e) {
    const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()
    if (t) return t
    const al = (e.getAttribute('aria-label') || '').trim()
    if (al) return al
    const ph = (e.getAttribute('placeholder') || '').trim()
    if (ph) return 'the ' + ph
    const tag = e.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' ? 'the input box' : 'the ' + tag
  }

  /**
   * visibility-pack 1.2: persistent focus outline + floating label chip.
   * One outline div + one label chip are created once and MOVED between
   * elements - cheap, no per-region DOM churn. `label` is what the model is
   * touching/reading; call clearFocus() at turn end.
   */
  function focus(el, label, rgba) {
    try {
      let box = document.getElementById('__dshAugFocusBox')
      let chip = document.getElementById('__dshAugFocusChip')
      if (!box) {
        box = document.createElement('div')
        box.id = '__dshAugFocusBox'
        box.style.cssText =
          'position:fixed;pointer-events:none;z-index:2147483646;' +
          'border:2px solid rgba(79,139,255,.9);border-radius:10px;' +
          'box-shadow:0 0 20px rgba(79,139,255,.30);' +
          'transition:left .18s ease, top .18s ease, width .18s ease, height .18s ease;'
        document.body.appendChild(box)
      }
      if (!chip) {
        chip = document.createElement('div')
        chip.id = '__dshAugFocusChip'
        chip.style.cssText =
          'position:fixed;pointer-events:none;z-index:2147483647;' +
          'font:600 11px system-ui;color:#fff;' +
          'background:rgba(37,99,235,.92);' +
          'padding:3px 10px;border-radius:99px;' +
          'transition:left .18s ease, top .18s ease;max-width:280px;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
          'box-shadow:0 2px 8px rgba(0,0,0,.25)'
        document.body.appendChild(chip)
      }
      const r = el.getBoundingClientRect()
      box.style.left = r.x - 4 + 'px'
      box.style.top = r.y - 4 + 'px'
      box.style.width = r.width + 8 + 'px'
      box.style.height = r.height + 8 + 'px'
      box.style.display = 'block'
      chip.textContent = (label || humanName(el)).slice(0, 60)
      chip.style.left = r.x + 'px'
      chip.style.top = Math.max(4, r.y - 26) + 'px'
      chip.style.display = 'block'
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {
      /* visual only - never fail an action for it */
    }
  }

  function clearFocus() {
    try {
      const box = document.getElementById('__dshAugFocusBox')
      const chip = document.getElementById('__dshAugFocusChip')
      if (box) box.style.display = 'none'
      if (chip) chip.style.display = 'none'
    } catch { /* visual only */ }
  }

  /**
   * Pulse the element with a soft boxShadow bloom in the accent color.
   * `rgba` is the "rgba(r, g, b" prefix of the accent (sw.js keeps the
   * suffix off so the per-frame alpha can vary).
   */
  function pulse(el, rgba) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      el.animate(
        [
          { boxShadow: `0 0 0 0 ${rgba}, 0)` },
          { boxShadow: `0 0 0 6px ${rgba}, 0.65)` },
          { boxShadow: `0 0 0 0 ${rgba}, 0)` },
        ],
        { duration: 900, iterations: 2 },
      )
    } catch {
      /* visual only — never fail the action for it */
    }
  }

  /**
   * Ripple ring at the element's center: a small accent-bordered circle
   * that scales out and fades, removed on finish.
   */
  function ripple(el, rgba) {
    try {
      const b = el.getBoundingClientRect()
      const r = document.createElement('div')
      r.style.cssText =
        `position:fixed;left:${b.left + b.width / 2}px;top:${b.top + b.height / 2}px;` +
        'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
        `border:2px solid ${rgba}, 0.9);pointer-events:none;z-index:2147483647;`
      ;(document.body ?? document.documentElement).append(r)
      r.animate(
        [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(7)', opacity: 0 }],
        { duration: 750, easing: 'ease-out' },
      ).onfinish = () => r.remove()
    } catch {
      /* visual only */
    }
  }

  /** pulse + ripple in one call (the click/type visual). */
  function act(el, rgba) {
    pulse(el, rgba)
    ripple(el, rgba)
  }

  globalThis.__dshAugDom = { humanName, pulse, ripple, act,
    focus,
    clearFocus,
  }
})()
