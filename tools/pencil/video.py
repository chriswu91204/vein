import cv2, numpy as np, subprocess, sys, json
from pencil import pencil, wb_gains
def probe(src):
    o=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height:format=duration','-of','json',src]))
    return o['streams'][0]['width'],o['streams'][0]['height'],float(o['format']['duration'])
def render(src,dst,poster=None,W=None,H=None,fps=15,ss=0,dur=None,crf=27,wb=0.0):
    w0,h0,d=probe(src); W=W or w0; H=H or h0; dur=dur or d-ss
    scale=W/680
    cmd=['ffmpeg','-v','error','-ss',str(ss),'-t',str(dur),'-i',src,'-vf',f'fps={fps},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}','-f','rawvideo','-pix_fmt','bgr24','-']
    rd=subprocess.Popen(cmd,stdout=subprocess.PIPE)
    enc=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','bgr24','-s',f'{W}x{H}','-r',str(fps),'-i','-','-an','-c:v','libx264','-preset','slow','-crf',str(crf),'-pix_fmt','yuv420p','-movflags','+faststart',dst],stdin=subprocess.PIPE)
    n=0; gains=None; first=None
    while True:
        b=rd.stdout.read(W*H*3)
        if len(b)<W*H*3: break
        f=np.frombuffer(b,np.uint8).reshape(H,W,3)
        if gains is None and wb>0: gains=wb_gains(f,wb)
        o=pencil(f,seed=(n//2)%3,scale=scale,gains=gains)
        if first is None: first=o
        enc.stdin.write(o.tobytes()); n+=1
    enc.stdin.close(); enc.wait(); rd.wait()
    if poster is not None: cv2.imwrite(poster,first,[cv2.IMWRITE_JPEG_QUALITY,84])
    return n
if __name__=='__main__':
    a=sys.argv; print(render(a[1],a[2],a[3] if len(a)>3 else None))
