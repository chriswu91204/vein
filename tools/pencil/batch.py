import video, cv2, os, glob, sys
from multiprocessing import Pool
import pencil as P
orig=P.pencil
def soft(f,seed=0,scale=1,gains=None): return cv2.GaussianBlur(orig(f,seed,scale,gains),(0,0),0.55)
video.pencil=soft
M='/home/claude/vein-repo/public/m/'
def job(name):
    src=M+name+'.mp4'; hd=name.endswith('-hd')
    n=video.render(src,'out/'+name+'.mp4','out/'+name+'.jpg',fps=8,crf=34 if hd else 33)
    return name,n,os.path.getsize('out/'+name+'.mp4')//1024
def photo(name):
    im=cv2.imread(M+name+'.jpg'); o=cv2.GaussianBlur(orig(im,0,im.shape[1]/680),(0,0),0.5)
    cv2.imwrite('out/'+name+'.jpg',o,[cv2.IMWRITE_JPEG_QUALITY,82]); return name,os.path.getsize('out/'+name+'.jpg')//1024
if __name__=='__main__':
    clips=sorted(os.path.basename(f)[:-4] for f in glob.glob(M+'*.mp4'))
    with Pool(int(sys.argv[1])) as p:
        for r in p.imap_unordered(job,clips): print(r,flush=True)
        for r in p.imap_unordered(photo,['p1','p2','p3','p4','p5']): print(r,flush=True)
