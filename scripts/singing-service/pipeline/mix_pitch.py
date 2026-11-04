"""Conservative octave evidence from the aligned, unseparated song."""
import numpy as np
from f0_path import pitch_jumps


def _raise_with_reference(primary, mixture, source_probability, hop_seconds=.01, eligible=None, min_support=.6,
                          finish_phrase=False):
    out = np.asarray(primary).copy()
    mixture = np.asarray(mixture)
    probability = np.asarray(source_probability)
    if len(out) != len(mixture) or len(out) != len(probability):
        raise ValueError('Mix reference must share the vocal time axis')
    valid = (out > 0) & np.isfinite(mixture) & (mixture > 0) & (out * 2 <= 1100)
    if eligible is not None:
        valid &= eligible
    with np.errstate(divide='ignore', invalid='ignore'):
        distance = np.abs(12*np.log2(mixture / (out*2)))
    candidate = valid & (distance <= 1)
    edges = np.diff(np.r_[False, candidate, False].astype(int))
    accepted = np.zeros(len(out), dtype=bool)
    minimum = max(1, round(.08/hop_seconds))
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        # A confident monophonic low note is a poor reason to follow an instrument.
        if end-start >= minimum and np.isfinite(probability[start:end]).all() and np.mean(probability[start:end]) < .65:
            accepted[start:end] = True
    # Isolated agreement with an octave instrument is insufficient. Require at
    # least 600 ms of sustained disagreements in a local six-second context.
    prefix = np.r_[0, np.cumsum(accepted)]
    centers = np.arange(len(out))
    radius = round(3/hop_seconds)
    support = prefix[np.minimum(len(out), centers+radius+1)] - prefix[np.maximum(0, centers-radius)]
    accepted &= support >= round(min_support/hop_seconds)
    seeds = accepted.copy()
    # A framewise patch can create an octave jump at both ends of every island.
    # Let adjacent uncertain frames share its register, using actual pitch
    # continuity rather than holding the octave multiplier constant.
    margin = round(.4/hop_seconds)
    seed_prefix = np.r_[0, np.cumsum(seeds)]
    allowed = (seed_prefix[np.minimum(len(out), centers+margin+1)] -
               seed_prefix[np.maximum(0, centers-margin)] > 0) & valid
    accepted[:] = False
    voiced_edges = np.diff(np.r_[False, out>0, False].astype(int))
    for start, end in zip(np.flatnonzero(voiced_edges==1), np.flatnonzero(voiced_edges==-1)):
        if not seeds[start:end].any():
            continue
        if finish_phrase:
            allowed_indices=np.flatnonzero(allowed[start:end])
            tail=start+int(allowed_indices[-1])+1 if len(allowed_indices) else end
            if (0<end-tail<=round(.15/hop_seconds) and valid[tail:end].all()
                    and np.isfinite(probability[tail:end]).all() and np.mean(probability[tail:end])<.65):
                allowed[tail:end]=True
        candidates = out[start:end,None] * np.array([1.,2.])
        emission = np.column_stack((np.where(seeds[start:end],.8,0.),np.full(end-start,.04)))
        emission[~allowed[start:end],1] = np.inf
        cost=emission[0].copy()
        back=np.zeros((end-start,2),dtype=int)
        for i in range(1,end-start):
            delta=np.abs(12*np.log2(candidates[i][None,:]/candidates[i-1][:,None]))
            transition=.08*np.maximum(delta-3,0)**2
            choices=cost[:,None]+transition
            back[i]=np.argmin(choices,axis=0)
            cost=choices[back[i],np.arange(2)]+emission[i]
        state=int(np.argmin(cost))
        for i in range(end-start-1,-1,-1):
            accepted[start+i]=bool(state)
            state=back[i,state]
    out[accepted] *= 2
    rejected = pitch_jumps(out) > pitch_jumps(primary)
    if rejected:
        out = np.asarray(primary).copy()
        accepted[:] = False
    edges = np.diff(np.r_[False, accepted, False].astype(int))
    report = {'version': 2, 'reference_supported_frames': int(seeds.sum()),
              'raised_frames': int(accepted.sum()), 'lowered_frames': 0,
              'voicing_changed_frames': 0,
              'rejected_new_octave_jumps': bool(rejected),
              'events': [{'start': round(int(i)*hop_seconds, 4), 'end': round(int(j)*hop_seconds, 4)}
                         for i,j in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1))]}
    return out, report, seeds


def waveform_octave_scores(f0, audio, sr=16000, hop=160):
    """Half-period correlation and even/odd harmonic power, in bounded batches."""
    audio=np.asarray(audio,dtype=float)
    padded=np.pad(audio,(512,1024),mode='reflect')
    frames=np.lib.stride_tricks.sliding_window_view(padded,1024)[::hop]
    result=np.full((len(f0),4),np.nan)
    window=np.hanning(1024)
    for start in range(0,min(len(frames),len(f0)),256):
        count=min(256,len(frames)-start,len(f0)-start)
        frequencies=np.asarray(f0[start:start+count])
        spectrum=np.abs(np.fft.rfft(frames[start:start+count]*window,n=4096,axis=1))**2
        ac=np.fft.irfft(spectrum,n=4096,axis=1)[:,:1024]
        ac/=np.maximum(ac[:,0:1],1e-12)
        for j,f in enumerate(frequencies):
            if not np.isfinite(f) or f<=0 or f*2>1100:
                continue
            lag=sr/f
            if lag>=1022:
                continue
            def at(position):
                index=round(position)
                return float(ac[j,max(1,index-1):index+2].max())
            full,half=at(lag),at(lag/2)
            harmonics=[]
            for harmonic in range(1,13):
                if f*harmonic>6000:
                    break
                center=round(f*harmonic/sr*4096)
                radius=max(1,round(f*.035/sr*4096))
                harmonics.append(float(spectrum[j,max(0,center-radius):center+radius+1].max()))
            if len(harmonics)<2:
                continue
            odd=np.mean(harmonics[::2]);even=np.mean(harmonics[1::2])
            result[start+j]=half,half/max(full,1e-9),10*np.log10(max(even,1e-12)/max(odd,1e-12)),full
    return result


def _near(mask, seconds, hop_seconds):
    prefix=np.r_[0,np.cumsum(mask)]
    centers=np.arange(len(mask));radius=round(seconds/hop_seconds)
    return prefix[np.minimum(len(mask),centers+radius+1)]-prefix[np.maximum(0,centers-radius)]>0


def raise_from_mix(primary, mixture, source_probability, hop_seconds=.01, waveforms=None, sr=16000,
                   waveform_scores=None):
    out,report,seeds=_raise_with_reference(primary,mixture,source_probability,hop_seconds)
    if (not waveforms and waveform_scores is None) or np.sum(seeds)<round(.6/hop_seconds):
        return out,report
    # These are register anchors from a different signal, not a blanket choice
    # of the strongest harmonic. No anchors means no waveform-based correction.
    anchors=np.asarray(mixture)[seeds]
    lower,upper=np.percentile(anchors,[10,90])*np.array([.85,1.25])
    in_register=(out>0)&(out*2>=lower)&(out*2<=min(upper,1100))
    # A global percentile describes the usual register, not its highest note.
    # A short upper excursion may follow an already observed high note; require
    # both source signals to corroborate it before relaxing the usual bound.
    from scipy.ndimage import maximum_filter1d
    local_high=maximum_filter1d(np.where(out>=lower,out,0.),
        size=2*round(3/hop_seconds)+1,mode='constant')
    excursion_upper=np.minimum(1100,np.maximum(upper,local_high*2**(2/12)))
    in_excursion=(out>0)&(out*2>=lower)&(out*2<=excursion_upper)
    probability=np.asarray(source_probability)
    plausible=np.isfinite(probability)
    strong=np.zeros(len(out),dtype=bool)
    weak=strong.copy()
    observations=[]
    corroborated=[]
    scores=(waveform_scores if waveform_scores is not None else
            [waveform_octave_scores(out,waveform,sr=sr,hop=round(hop_seconds*sr)) for waveform in waveforms])
    for evidence in scores:
        if np.asarray(evidence).shape!=(len(out),4):
            raise ValueError('Waveform scores must share the pitch time axis')
        half,ratio,power,full=evidence.T
        strong|=(half>=.45)&(ratio>=.8)&(power>=6)&(full>=.2)
        weak|=(half>=.3)&(ratio>=.6)&(power>=3)&(full>=.2)
        observations.append(evidence)
        corroborated.append((half>=.4)&(ratio>=.6)&(power>=5)&(full>=.2))
    if len(corroborated)>=2:
        dual=np.all(corroborated,axis=0)
        strong|=dual
    else:
        dual=np.zeros(len(out),dtype=bool)
    allowed_register=in_register|(in_excursion&dual)
    strong&=plausible&allowed_register&_near(seeds,3,hop_seconds)
    weak&=plausible&in_register&(probability<.65)&_near(strong|seeds,1.5,hop_seconds)
    eligible=(allowed_register|(in_excursion&_near(strong,.03,hop_seconds)))&(out<=np.asarray(primary)+.00001)
    supported=strong|weak
    gaps=np.diff(np.r_[True,supported,True].astype(int))
    for start,end in zip(np.flatnonzero(gaps==-1),np.flatnonzero(gaps==1)):
        if (start>0 and end<len(out) and end-start<=round(.03/hop_seconds)
                and eligible[start:end].all()):
            notes=out[start-1:end+1]
            if np.min(notes)>0 and 12*np.log2(np.max(notes)/np.min(notes))<=3:
                supported[start:end]=True
    reference=np.where(supported,out*2,out)
    # pYIN can confidently report the mathematical subharmonic. Strong acoustic
    # evidence may bypass that veto; weak evidence still requires low confidence.
    veto_probability=np.where(strong,np.minimum(probability,.5),probability)
    refined,extra,_=_raise_with_reference(out,reference,veto_probability,hop_seconds,
                                        eligible=eligible,min_support=.2,finish_phrase=True)
    report['version']=4
    report['waveform_refinement']=extra
    report['waveform_register_hz']=[float(lower),float(min(upper,1100))]
    report['waveform_excursion_frames']=int(np.sum(strong&~in_register))
    report['waveform_strong_frames']=int(strong.sum())
    report['waveform_weak_frames']=int(weak.sum())
    report['raised_frames']=int(np.sum(refined>np.asarray(primary)))
    # Keep the compact scores for caller diagnostics, not the FFT matrices.
    report['_waveform_evidence']={'scores':np.stack(observations),'before':out,
                                  'after':refined,'strong':strong,'weak':weak}
    return refined,report
