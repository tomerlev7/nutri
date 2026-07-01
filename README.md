# 🌿 נוטרי — אפליקציית תזונה ואימונים

## Deploy על Vercel

### 1. העלה ל-GitHub
```bash
git init
git add .
git commit -m "Initial commit — Nutri app"
git remote add origin https://github.com/YOUR_USERNAME/nutri.git
git push -u origin main
```

### 2. חבר ל-Vercel
1. כנס ל-[vercel.com](https://vercel.com)
2. "Add New Project" → בחר את ה-repo מ-GitHub
3. Vercel מזהה Vite אוטומטית

### 3. הוסף API Key
בהגדרות הפרויקט ב-Vercel:
**Settings → Environment Variables → Add:**
```
Name:  ANTHROPIC_API_KEY
Value: sk-ant-...  (המפתח שלך מ-anthropic.com/account)
```

### 4. Redeploy
לאחר הוספת המפתח — Vercel → Deployments → Redeploy

### פיתוח מקומי
```bash
npm install
# צור קובץ .env.local:
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
npm run dev
```

## Stack
- React 18 + Vite
- Recharts
- Vercel Serverless Functions (API proxy)
- localStorage לנתונים
