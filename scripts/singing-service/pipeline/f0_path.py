"""Choose a continuous pitch path; confidence values are estimator-specific evidence."""
import numpy as np

VERSION = 1


def pitch_jumps(f0, semitones=8):
    f = np.asarray(f0)
    valid = (f[1:] > 0) & (f[:-1] > 0)
    delta = 12*np.log2(np.maximum(f[1:], 1)/np.maximum(f[:-1], 1))
    return int(np.sum(valid & (abs(delta) > semitones)))


def describe_path(evidence, hop_seconds=.01):
    r, out = evidence[:, 0], evidence[:, 5]
    chosen, joint = evidence[:, 6].astype(int), evidence[:, 7].astype(bool)
    active, filled = out > 0, (r == 0) & (out > 0)
    changed = abs(out-r) > 1e-5
    intervals = []
    i, n = 0, len(r)
    while i < n:
        if not changed[i]:
            i += 1
            continue
        j = i+1
        while j < n and changed[j]:
            j += 1
        intervals.append({'start': round(i*hop_seconds, 6), 'end': round(j*hop_seconds, 6),
                          'filled_frames': int(filled[i:j].sum()),
                          'joint_support_frames': int(joint[i:j].sum())})
        i = j
    return {'version': VERSION, 'frames': n,
            'phrases': int(np.sum(active & ~np.r_[False, active[:-1]])) if n else 0,
            'changed_frames': int(changed.sum()), 'filled_frames': int(filled.sum()),
            'jumps_before': pitch_jumps(r), 'jumps_after': pitch_jumps(out),
            'selected': {name: int(np.sum(active & (chosen == k))) for k, name in
                         enumerate(('primary', 'half', 'double', 'crepe', 'pyin'))},
            'intervals': intervals}


def select_pitch_path(primary, crepe, periodicity, pyin, probability, hop_seconds=.01):
    """Viterbi over voiced phrases, with explicit, bounded UV-gap evidence.

    Existing rests stay rests unless both independent references support an internal
    dropout. Octave alternatives let the path cross unreliable reference frames
    without toggling register whenever one confidence threshold is crossed.
    """
    r = np.asarray(primary, dtype=float)
    n = len(r)
    arrays = [np.asarray(a, dtype=float) for a in (crepe, periodicity, pyin, probability)]
    if any(a.shape != r.shape for a in arrays) or r.ndim != 1 or hop_seconds <= 0:
        raise ValueError('Pitch and confidence arrays must be aligned one-dimensional frames')
    if not np.isfinite(r).all() or (r < 0).any():
        raise ValueError('Primary pitch must be finite and nonnegative')
    c, cp, p, pp = arrays
    cp = np.clip(np.nan_to_num(cp), 0, 1)
    pp = np.clip(np.nan_to_num(pp), 0, 1)
    cv = np.isfinite(c) & (c >= 50) & (c <= 1100) & (cp >= .35)
    pv = np.isfinite(p) & (p >= 50) & (p <= 1100) & (pp >= .08)
    lc = 12*np.log2(np.maximum(np.nan_to_num(c), 1))
    lp = 12*np.log2(np.maximum(np.nan_to_num(p), 1))
    joint = cv & pv & (cp >= .5) & (pp >= .15) & (abs(lc-lp) <= .75)
    active = r > 0
    filled = np.zeros(n, dtype=bool)
    i = 0
    while i < n:
        if active[i]:
            i += 1
            continue
        j = i+1
        while j < n and not active[j]:
            j += 1
        if i > 0 and j < n and j-i <= round(.3/hop_seconds):
            # Do not bridge a real rest merely because CREPE returns a pitch for noise.
            # A vowel may end inside the hole; retain its trailing consonant as UV.
            supported = cv & (cp >= .5) & np.isfinite(p) & (abs(lc-lp) <= 1.5)
            a = i
            while a < j:
                if not supported[a]:
                    a += 1
                    continue
                b = a+1
                while b < j and supported[b]:
                    b += 1
                anchored = (abs(lc[a]-12*np.log2(r[i-1])) <= 3 or
                            abs(lc[b-1]-12*np.log2(r[j])) <= 3)
                if b-a >= round(.06/hop_seconds) and joint[a:b].mean() >= .6 and anchored:
                    active[a:b] = True
                    filled[a:b] = True
                a = b
        i = j

    candidates = np.column_stack((r, r*.5, r*2, c, p))
    valid = np.isfinite(candidates) & (candidates >= 50) & (candidates <= 1100)
    valid[:, 0] = r > 0
    valid[:, 3] &= cv
    valid[:, 4] &= pv
    logpitch = 12*np.log2(np.maximum(np.nan_to_num(candidates), 1))
    lr = 12*np.log2(np.maximum(r, 1))
    # A capped distance limits the influence of a confidently wrong octave estimate.
    cost = .28*np.minimum(abs(logpitch-lr[:, None]), 6)*(r > 0)[:, None]
    cost += (.85*cp*cv)[:, None]*np.minimum(abs(logpitch-lc[:, None]), 6)
    cost += (.85*np.sqrt(pp)*pv)[:, None]*np.minimum(abs(logpitch-lp[:, None]), 6)
    cost += np.array([0, .12, .12, .08, .08])[None, :]
    cost[~valid] = np.inf
    out = r.copy()
    chosen = np.zeros(n, dtype=int)
    phrases = 0
    i = 0
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i+1
        while j < n and active[j]:
            j += 1
        phrases += 1
        score = cost[i].copy()
        back = np.zeros((j-i, 5), dtype=np.int8)
        for t in range(i+1, j):
            distance = abs(logpitch[t-1, :, None]-logpitch[t, None, :])
            transition = .08*np.minimum(distance, 3)+1.2*np.maximum(distance-3, 0)
            options = score[:, None]+transition
            parents = options.argmin(axis=0)
            back[t-i] = parents
            score = cost[t]+options[parents, np.arange(5)]
        state = int(score.argmin())
        for t in range(j-1, i-1, -1):
            chosen[t] = state
            out[t] = candidates[t, state]
            state = int(back[t-i, state])
        i = j

    evidence = np.column_stack((r, c, cp, p, pp, out, chosen, joint.astype(int)))
    report = describe_path(evidence, hop_seconds)
    dtype = np.asarray(primary).dtype
    return out.astype(dtype if dtype.kind == 'f' else float), report, evidence
