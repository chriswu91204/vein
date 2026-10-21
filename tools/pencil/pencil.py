import cv2, numpy as np
_c={}
def paper(h,w):
    k=('p',h,w)
    if k not in _c:
        r=np.random.default_rng(3)
        n=cv2.GaussianBlur(r.random((h,w)).astype(np.float32),(0,0),0.8); n=(n-n.mean())/n.std()
        fib=cv2.GaussianBlur(r.random((h,w)).astype(np.float32),(0,0),12); fib=(fib-fib.mean())/fib.std()
        base=np.array([234,242,247],np.float32)/255
        _c[k]=(np.clip(base*(1+0.022*n[...,None]+0.007*fib[...,None]),0,1), n)
    return _c[k]
def strokefield(h,w,angle,seed,scale=1.0,dens=0.10):
    """field of short pencil lines; each line has a random threshold value v (0..1); background=1"""
    k=('f',h,w,angle,seed,scale)
    if k not in _c:
        r=np.random.default_rng(seed)
        N=int(h*w*dens/scale/scale/6)
        F=np.ones((h,w),np.float32)
        A=np.zeros((h,w),np.float32)
        xs=r.uniform(-20,w+20,N); ys=r.uniform(-20,h+20,N)
        ln=r.uniform(8,26,N)*scale; ang=np.deg2rad(angle+r.normal(0,6,N))
        v=r.random(N); order=np.argsort(-v)
        th=max(1,int(round(scale)))
        for i in order:
            dx=np.cos(ang[i])*ln[i]/2; dy=-np.sin(ang[i])*ln[i]/2
            p1=(int(xs[i]-dx),int(ys[i]-dy)); p2=(int(xs[i]+dx),int(ys[i]+dy))
            cv2.line(F,p1,p2,float(v[i]),th,cv2.LINE_AA)
        # pressure variation along strokes
        P=cv2.GaussianBlur(r.random((h,w)).astype(np.float32),(0,0),3*scale)
        P=0.55+0.9*(P-P.min())/(P.max()-P.min()+1e-6)
        _c[k]=(F,np.clip(P,0,1.2))
    return _c[k]
def smooth(img):
    sm=cv2.bilateralFilter(img,9,50,7)
    for _ in range(2): sm=cv2.bilateralFilter(sm,7,30,5)
    return sm
def wb_gains(img,strength=0.7):
    m=img.reshape(-1,3).astype(np.float32).mean(0); g=m.mean()/m
    return 1+(g-1)*strength
def pencil(img, seed=0, scale=1.0, gains=None):
    h,w=img.shape[:2]
    if gains is not None: img=np.clip(img.astype(np.float32)*gains,0,255).astype(np.uint8)
    sm=smooth(img)
    hsv=cv2.cvtColor(sm,cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[...,1]=np.clip(hsv[...,1]*1.55,0,255); hsv[...,2]=np.clip(hsv[...,2]*1.06,0,255)
    col=cv2.cvtColor(hsv.astype(np.uint8),cv2.COLOR_HSV2BGR).astype(np.float32)/255
    lum=cv2.cvtColor(sm,cv2.COLOR_BGR2GRAY).astype(np.float32)/255
    sat=hsv[...,1]/255
    dark=np.clip((1-lum-0.18)/0.72,0,1)
    satw=np.clip((sat-0.10)/0.25,0,1)
    tone=np.clip(dark*(0.42+0.58*satw)+np.clip(dark-0.55,0,1)*0.8,0,1)
    tone=cv2.GaussianBlur(tone,(0,0),1.0)
    P,pn=paper(h,w)
    def lay(angle,k,cov):
        F,Pr=strokefield(h,w,angle,seed*11+k,scale)
        return np.clip((cov-F)*10,0,1)*Pr
    m=lay(38,1,tone)
    m=np.maximum(m,lay(-50,2,np.clip(tone*1.5-0.4,0,1))*0.9)
    m=np.maximum(m,lay(80,3,np.clip(tone*1.8-1.0,0,1))*0.8)
    m=np.clip(m*(0.85+0.2*pn),0,1)[...,None]
    # pigment tint under strokes: light colour wash (like blended pencil)
    wash=(tone*0.62)[...,None]
    base=P*(1-wash*(1-col))
    pig=np.clip(col*0.9,0,1)*P
    out=base*(1-m*0.9)+pig*m*0.9
    # outlines
    g1=cv2.GaussianBlur(lum,(0,0),1.0*scale); g2=cv2.GaussianBlur(lum,(0,0),2.4*scale)
    e=np.clip((g2-g1)*13,0,1)
    ed=cv2.Canny(sm,35,100).astype(np.float32)/255
    ed=cv2.GaussianBlur(ed,(0,0),0.6*scale)*1.6
    F,Pr=strokefield(h,w,0,seed*11+5,scale)
    e=np.clip(np.maximum(e,ed)*np.clip(Pr,0.4,1),0,1)[...,None]
    line=np.clip(col*0.42+0.04,0,1)
    out=out*(1-e*0.75)+line*e*0.75
    return np.clip(out*255,0,255).astype(np.uint8)
if __name__=='__main__':
    import sys,time
    t=time.time(); im=cv2.imread(sys.argv[1]); cv2.imwrite(sys.argv[2],pencil(im,scale=float(sys.argv[3]) if len(sys.argv)>3 else 1.0),[cv2.IMWRITE_JPEG_QUALITY,90]); print(time.time()-t)
