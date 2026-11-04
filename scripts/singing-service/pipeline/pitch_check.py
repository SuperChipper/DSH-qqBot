"""Measure synthesis against its final target, without treating source F0 as truth."""
import numpy as np


def sample_target(path, times, audio_duration):
    curve=np.loadtxt(path,delimiter=',',ndmin=2)
    if (curve.shape[1]!=2 or len(curve)<2 or not np.isfinite(curve).all()
            or abs(curve[0,0])>.02 or np.any(np.diff(curve[:,0])<=0)
            or np.any(curve[:,1]<0) or np.any(curve[:,1]>1200)):
        raise ValueError('最终目标 F0 CSV 无效')
    if abs(curve[-1,0]-audio_duration)>.1:
        raise ValueError('目标 F0 与音频时长不符，可能使用了其他片段的曲线')
    times=np.asarray(times)
    right=np.clip(np.searchsorted(curve[:,0],times),0,len(curve)-1)
    left=np.maximum(right-1,0)
    nearest=np.where(abs(times-curve[left,0])<=abs(times-curve[right,0]),left,right)
    out=curve[nearest,1].copy()
    out[(times<curve[0,0]-.02)|(times>curve[-1,0]+.02)]=np.nan
    return out


def pitch_relation(observed, reference, expected_shift=0):
    n=min(len(observed),len(reference))
    a,b=np.asarray(observed)[:n],np.asarray(reference)[:n]
    both=np.isfinite(a)&np.isfinite(b)&(a>0)&(b>0)
    errors=12*np.log2(a[both]/b[both])-expected_shift
    return {'compared_frames':int(both.sum()),
            'median_semitones':float(np.median(errors)) if len(errors) else None,
            'over_one_semitone_percent':float(100*np.mean(abs(errors)>1)) if len(errors) else None,
            'octave_error_frames':int(np.sum(abs(abs(errors)-12)<=1))}


def target_compliance(observed, expected):
    observed,expected=np.asarray(observed),np.asarray(expected)
    if observed.shape!=expected.shape:
        raise ValueError('输出和目标 F0 时间轴不一致')
    target_voiced=np.isfinite(expected)&(expected>0)
    output_voiced=np.isfinite(observed)&(observed>0)
    report=pitch_relation(observed,expected)
    count=int(target_voiced.sum())
    coverage=float(np.sum(target_voiced&output_voiced)/count) if count else None
    report.update(expected_voiced_frames=count,voiced_coverage=coverage,
                  unvoiced_target_output_voiced_frames=int(np.sum((expected==0)&output_voiced)),
                  missing_target_frames=int(np.sum(~np.isfinite(expected))))
    if not count:
        report.update(status='unverified',reason='目标没有有声音高，无法验证音高跟随')
    elif report['compared_frames']<50 or coverage<.5 or report['missing_target_frames']:
        report.update(status='unverified',reason='可比音高帧或覆盖率不足，不能据此断言唱错或通过')
    else:
        passed=abs(report['median_semitones'])<.5 and report['over_one_semitone_percent']<15
        report.update(status='pass' if passed else 'warn',reason='输出对最终目标的逐帧偏差')
    return report
