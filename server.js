const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// ===== إعدادات التطبيق - 200 ميجا =====
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 ميجا بايت
const MAX_FILES = 5; // قلل العدد للملفات الكبيرة
const MAX_MEMORY = process.env.MEMORY_LIMIT || 1024; // 1 جيجا

console.log(`📦 الحد الأقصى للملف: ${MAX_FILE_SIZE / 1024 / 1024} MB`);
console.log(`📦 الحد الأقصى للعدد: ${MAX_FILES} ملفات`);

// ===== تحسينات الأمان والأداء =====
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path === '/merge') {
      return false;
    }
    return true;
  }
}));

// ===== تحديد حدود الطلبات =====
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // قلل العدد للملفات الكبيرة
  message: 'تجاوزت عدد الطلبات المسموح بها، حاول لاحقاً'
});
app.use('/merge', limiter);

// ===== تكوين Multer للملفات الكبيرة =====
const storage = multer.memoryStorage({
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
    fieldSize: 200 * 1024 * 1024 // 200 ميجا للحقول
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
    fieldSize: 200 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || 
        file.mimetype === 'application/x-pdf' ||
        file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('❌ فقط ملفات PDF مسموح بها'), false);
    }
  }
});

// ===== عرض واجهة المستخدم =====
app.use(express.static('public'));

// ===== API الرئيسي للدمج - محسن للملفات الكبيرة =====
app.post('/merge', upload.array('pdfs', MAX_FILES), async (req, res) => {
  const startTime = Date.now();
  let memoryUsed = process.memoryUsage();

  console.log(`📥 استلام طلب دمج - ${req.files?.length || 0} ملفات`);
  console.log(`💾 الذاكرة قبل المعالجة: ${Math.round(memoryUsed.rss / 1024 / 1024)} MB`);

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'الرجاء رفع ملفات PDF للدمج'
      });
    }

    // حساب الحجم الإجمالي
    const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
    const totalSizeMB = totalSize / 1024 / 1024;
    
    console.log(`📊 الحجم الإجمالي: ${totalSizeMB.toFixed(2)} MB`);

    // التحقق من الحجم الإجمالي
    if (totalSize > MAX_FILE_SIZE * MAX_FILES) {
      return res.status(413).json({
        success: false,
        error: `الحجم الإجمالي يتجاوز ${(MAX_FILE_SIZE * MAX_FILES) / 1024 / 1024} ميجا`
      });
    }

    // إنشاء مستند PDF جديد
    const mergedPdf = await PDFDocument.create();
    let pageCount = 0;

    // ===== معالجة الملفات واحداً تلو الآخر للملفات الكبيرة =====
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileSizeMB = file.size / 1024 / 1024;
      
      console.log(`📄 معالجة الملف ${i + 1}/${req.files.length}: ${file.originalname} (${fileSizeMB.toFixed(2)} MB)`);
      
      try {
        // قراءة الملف كـ ArrayBuffer
        const pdfBytes = file.buffer;
        
        // تحميل المستند مع خيارات محسنة للملفات الكبيرة
        const pdf = await PDFDocument.load(pdfBytes, {
          ignoreEncryption: true,
          updateMetadata: false,
          parseSpeed: 'Fast'
        });

        const pageIndices = pdf.getPageIndices();
        pageCount += pageIndices.length;
        console.log(`   📑 ${pageIndices.length} صفحات`);

        // نسخ الصفحات مع تحسين الذاكرة
        for (const pageIndex of pageIndices) {
          const [copiedPage] = await mergedPdf.copyPages(pdf, [pageIndex]);
          mergedPdf.addPage(copiedPage);
          
          // تنظيف الذاكرة كل 3 صفحات للملفات الكبيرة
          if (pageCount % 3 === 0 && global.gc) {
            global.gc();
          }
        }

        // تحرير الذاكرة
        pdfBytes.length = 0;
        file.buffer = null;
        req.files[i] = null;

        if (global.gc) {
          global.gc();
        }

        console.log(`   ✅ تمت المعالجة (الذاكرة: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB)`);

      } catch (err) {
        console.error(`❌ خطأ في الملف ${file.originalname}:`, err.message);
        return res.status(400).json({
          success: false,
          error: `خطأ في قراءة الملف: ${file.originalname}`,
          details: err.message
        });
      }
    }

    // ===== حفظ الملف النهائي =====
    console.log(`📄 حفظ الملف النهائي (${pageCount} صفحات)...`);
    
    const mergedBytes = await mergedPdf.save({
      useObjectStreams: false,
      addDefaultPage: false,
      objectsPerTick: 30, // أقل للملفات الكبيرة
      updateFieldAppearances: false
    });

    // تحرير الذاكرة
    mergedPdf.removeAllPages();
    if (global.gc) {
      global.gc();
    }

    // ===== إرسال الملف =====
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const finalMemory = process.memoryUsage();

    console.log(`✅ اكتمل الدمج في ${processingTime.toFixed(2)} ثانية`);
    console.log(`💾 الذاكرة النهائية: ${Math.round(finalMemory.rss / 1024 / 1024)} MB`);
    console.log(`📦 حجم الملف الناتج: ${Math.round(mergedBytes.length / 1024 / 1024)} MB`);

    // إرسال الملف
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=merged_${Date.now()}.pdf`);
    res.setHeader('X-Processing-Time', processingTime);
    res.setHeader('X-Page-Count', pageCount);
    res.setHeader('X-Files-Merged', req.files.length);
    res.setHeader('X-Total-Size-MB', totalSizeMB.toFixed(2));
    
    res.send(Buffer.from(mergedBytes));

    // تنظيف نهائي
    mergedBytes.length = 0;
    if (global.gc) {
      global.gc();
    }

  } catch (error) {
    console.error('❌ خطأ في الدمج:', error);
    
    if (global.gc) {
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء دمج الملفات',
      details: error.message
    });
  }
});

// ===== نقطة نهاية لمراقبة الصحة =====
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
      external: `${Math.round(mem.external / 1024 / 1024)} MB`
    },
    limits: {
      maxFileSize: `${MAX_FILE_SIZE / 1024 / 1024} MB`,
      maxFiles: MAX_FILES,
      maxMemory: `${MAX_MEMORY} MB`
    },
    uptime: process.uptime(),
    version: process.version,
    platform: process.platform
  });
});

// ===== نقطة نهاية لتنظيف الذاكرة =====
app.post('/cleanup', (req, res) => {
  if (global.gc) {
    global.gc();
    const mem = process.memoryUsage();
    res.json({ 
      success: true, 
      message: 'تم تنظيف الذاكرة',
      memory: `${Math.round(mem.rss / 1024 / 1024)} MB`
    });
  } else {
    res.json({ success: false, message: 'GC غير مفعل' });
  }
});

// ===== معالج الأخطاء =====
app.use((err, req, res, next) => {
  console.error('🔥 خطأ عام:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({
        success: false,
        error: `حجم الملف كبير جداً (الحد الأقصى ${MAX_FILE_SIZE / 1024 / 1024} ميجا)`
      });
    }
    if (err.code === 'TOO_MANY_FILES') {
      return res.status(413).json({
        success: false,
        error: `عدد الملفات تجاوز الحد (الحد الأقصى ${MAX_FILES} ملفات)`
      });
    }
    return res.status(400).json({
      success: false,
      error: 'خطأ في رفع الملف',
      details: err.message
    });
  }

  res.status(500).json({
    success: false,
    error: 'خطأ في الخادم',
    details: process.env.NODE_ENV === 'development' ? err.message : 'حدث خطأ غير متوقع'
  });
});

// ===== تشغيل الخادم =====
app.listen(PORT, () => {
  const mem = process.memoryUsage();
  console.log(`
╔══════════════════════════════════════════════╗
║  🚀 PDF Merger Server v3.0 - 200 MB       ║
╠══════════════════════════════════════════════╣
║  📡 المنفذ: ${PORT.toString().padEnd(26)}║
║  💾 الذاكرة: ${Math.round(mem.rss / 1024 / 1024)} MB${' '.repeat(19)}║
║  📦 الحد الأقصى للملفات: ${MAX_FILES}${' '.repeat(19)}║
║  📄 الحد الأقصى للحجم: 200 MB${' '.repeat(16)}║
║  ⚠️  يوصى بـ 1 جيجا ذاكرة على Railway${' '.repeat(6)}║
╚══════════════════════════════════════════════╝
  `);
});

// ===== تنظيف الذاكرة بشكل دوري =====
setInterval(() => {
  if (global.gc) {
    global.gc();
  }
  const mem = process.memoryUsage();
  console.log(`🧹 تنظيف الذاكرة: ${Math.round(mem.rss / 1024 / 1024)} MB مستخدمة`);
}, 60000);
