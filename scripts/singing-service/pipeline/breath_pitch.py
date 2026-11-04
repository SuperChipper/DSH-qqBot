"""Conservative upward-only repair of short half-frequency restarts near UV gaps."""
import numpy as np

VERSION = 2


def repair_breath_restarts(pitch, hop_seconds=.01, reference=None, probability=None):
    f = np.asarray(pitch, dtype=float)
    if f.ndim != 1 or not np.isfinite(f).all() or (f < 0).any() or hop_seconds <= 0:
        raise ValueError('Expected finite, nonnegative pitch frames and positive hop')
    out = f.copy()
    voiced = f >= 50
    repaired = np.zeros(len(f), dtype=bool)
    frames = lambda seconds: max(1, round(seconds/hop_seconds))
    hold, left_window = frames(.08), frames(.2)
    events = []
    i = 0
    while i < len(f):
        if voiced[i]:
            i += 1
            continue
        j = i+1
        while j < len(f) and not voiced[j]:
            j += 1
        if frames(.03) <= j-i <= frames(.6) and i >= hold and j < len(f):
            before = f[max(0, i-left_window):i]
            before = before[before >= 50]
            if len(before) >= hold:
                anchor = float(np.median(before))
                spread = float(np.ptp(np.percentile(12*np.log2(before/anchor), [25, 75])))
                if spread <= 1.5:
                    delta = 12*np.log2(np.maximum(f, 1)/anchor)
                    high = voiced & (abs(delta) <= 2)
                    low = voiced & (abs(delta+12) <= 2) & (f*2 <= 1100)
                    # The onset can include a few correct frames before dropping a register.
                    start = None
                    for s in range(j, min(len(f), j+frames(.25))):
                        if not voiced[s]:
                            break
                        if low[s]:
                            start = s
                            break
                        if not high[s]:
                            break
                    if start is not None:
                        for end in range(start+frames(.06), min(len(f)-hold+1, start+frames(.6))):
                            middle = slice(start, end)
                            if np.any(voiced[middle] & ~(low[middle] | high[middle])):
                                break
                            # A stable return is the second anchor; never extend the previous
                            # register through an entire lower phrase on historical pitch alone.
                            if not high[end:end+hold].all():
                                continue
                            indices = np.flatnonzero(low[middle])+start
                            if len(indices) >= frames(.06) and not repaired[indices].any():
                                out[indices] = f[indices]*2
                                repaired[indices] = True
                                events.append({'gap_start': round(i*hop_seconds, 6),
                                    'gap_end': round(j*hop_seconds, 6),
                                    'start': round(start*hop_seconds, 6),
                                    'end': round(end*hop_seconds, 6),
                                    'return_end': round((end+hold)*hop_seconds, 6),
                                    'frames': len(indices), 'anchor_hz': anchor,
                                    'raised_from_median_hz': float(np.median(f[indices]))})
                            break
        i = j
    if reference is not None:
        ref = np.asarray(reference, dtype=float)
        prob = np.asarray(probability, dtype=float)
        if ref.shape != f.shape or prob.shape != f.shape:
            raise ValueError('Reference frames must align with primary pitch')
        # A new note after a breath need not match the previous phrase. Require
        # an upper-octave source reference plus voiced anchors local to that note.
        candidate = (voiced & np.isfinite(ref) & (ref >= 50) & (ref <= 1100) &
                     (out*2 <= 1100) & (abs(12*np.log2(np.maximum(ref, 1)/np.maximum(out*2, 1))) <= 1.25))
        def has_hold(mask, count):
            run = 0
            for value in mask:
                run = run+1 if value else 0
                if run >= count:
                    return True
            return False
        s = 0
        while s < len(f):
            if not candidate[s]:
                s += 1
                continue
            # Keep the rule tied to a recent UV boundary, not arbitrary octave disagreements.
            recent = ~voiced[max(0, s-frames(.5)):s]
            if not has_hold(recent, frames(.03)):
                s += 1
                continue
            end, k, miss = s+1, s+1, 0
            while k < min(len(f), s+frames(.6)):
                if candidate[k]:
                    end, miss = k+1, 0
                else:
                    miss += 1
                    if miss > (frames(.15) if not voiced[k] else frames(.03)):
                        break
                k += 1
            if k == s+frames(.6) and k < len(f) and candidate[k]:
                while k < len(f) and candidate[k]:
                    k += 1
                s = k
                continue
            indices = np.flatnonzero(candidate[s:end])+s
            confidence = np.nan_to_num(prob[indices])
            supported_indices = indices[confidence >= .08]
            anchors = supported_indices if len(supported_indices) else indices
            first_upper = float(np.median(out[anchors[:5]])*2)
            last_upper = float(np.median(out[anchors[-5:]])*2)
            left = out[max(0, s-frames(.3)):s]
            right = out[end:min(len(f), end+frames(.35))]
            left_match = (left >= 50) & (abs(12*np.log2(np.maximum(left, 1)/first_upper)) <= 3)
            right_match = (right >= 50) & (abs(12*np.log2(np.maximum(right, 1)/last_upper)) <= 3)
            if (len(indices) >= frames(.06) and np.mean(confidence >= .08) >= .25 and
                    np.max(confidence, initial=0) >= .1 and len(supported_indices) >= 2 and
                    has_hold(left_match, frames(.06)) and has_hold(right_match, hold)):
                indices = indices[~repaired[indices]]
                if len(indices):
                    before_values = out[indices].copy()
                    out[indices] *= 2
                    repaired[indices] = True
                    events.append({'kind': 'source_supported_new_note',
                        'start': round(s*hop_seconds, 6), 'end': round(end*hop_seconds, 6),
                        'frames': len(indices), 'reference_supported_frames': int(np.sum(confidence >= .08)),
                        'raised_from_median_hz': float(np.median(before_values))})
            s = end
    report = {'version': VERSION, 'raised_frames': int(repaired.sum()),
              'lowered_frames': 0, 'voicing_changed_frames': 0, 'events': events}
    dtype = np.asarray(pitch).dtype
    return out.astype(dtype if dtype.kind == 'f' else float), report
