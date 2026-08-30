const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// ===== إعدادات التطبيق =====
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 ميجا بايت
const MAX_FILES = 10;
const MAX_MEMORY = process.env.MEMORY_LIMIT || 256; // ميجا بايت

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
      return false; // لا نضغط الملفات الكبيرة
    }
    return true;
  }
}));

// ===== تحديد حدود الطلبات =====
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 50, // حد أقصى 50 طلب لكل IP
  message: 'تجاوزت عدد الطلبات المسموح بها، حاول لاحقاً'
});
app.use('/merge', limiter);

// ===== تكوين Multer مع تحسين الذاكرة =====
const storage = multer.memoryStorage({
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
    fieldSize: 1024 * 1024 // 1 ميجا
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  },
  fileFilter: (req, file, cb) => {
    // التحقق من نوع الملف
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

// ===== API الرئيسي للدمج =====
app.post('/merge', upload.array('pdfs', MAX_FILES), async (req, res) => {
  const startTime = Date.now();
  let memoryUsed = process.memoryUsage();

  console.log(`📥 استلام طلب دمج - ${req.files.length} ملفات`);
  console.log(`💾 الذاكرة قبل المعالجة: ${Math.round(memoryUsed.rss / 1024 / 1024)} MB`);

  try {
    // التحقق من وجود ملفات
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'الرجاء رفع ملفات PDF للدمج'
      });
    }

    // التحقق من حجم الملفات الإجمالي
    const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_FILE_SIZE * MAX_FILES) {
      return res.status(413).json({
        success: false,
        error: `الحجم الإجمالي للملفات يتجاوز الحد المسموح (${MAX_FILE_SIZE * MAX_FILES / 1024 / 1024} ميجا)`
      });
    }

    // إنشاء مستند PDF جديد
    const mergedPdf = await PDFDocument.create();
    let pageCount = 0;

    // ===== معالجة الملفات واحداً تلو الآخر =====
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      
      try {
        // قراءة الملف كـ ArrayBuffer
        const pdfBytes = file.buffer;
        
        // تحميل المستند مع خيارات توفير الذاكرة
        const pdf = await PDFDocument.load(pdfBytes, {
          ignoreEncryption: true,
          updateMetadata: false,
          parseSpeed: 'Fast' // تسريع التحليل
        });

        // الحصول على عدد الصفحات
        const pageIndices = pdf.getPageIndices();
        pageCount += pageIndices.length;

        // نسخ الصفحات واحدة تلو الأخرى لتقليل استخدام الذاكرة
        for (const pageIndex of pageIndices) {
          const [copiedPage] = await mergedPdf.copyPages(pdf, [pageIndex]);
          mergedPdf.addPage(copiedPage);
          
          // تنظيف الذاكرة كل 5 صفحات
          if (pageCount % 5 === 0) {
            if (global.gc) {
              global.gc();
            }
          }
        }

        // تحرير الذاكرة المستخدمة
        pdfBytes.length = 0;
        file.buffer = null;
        req.files[i] = null;

        console.log(`✅ تمت معالجة الملف ${i + 1}/${req.files.length} (${pageIndices.length} صفحات)`);

      } catch (err) {
        console.error(`❌ خطأ في الملف ${file.originalname}:`, err.message);
        return res.status(400).json({
          success: false,
          error: `خطأ في قراءة الملف: ${file.originalname}`,
          details: err.message
        });
      }

      // تنظيف الذاكرة بعد كل ملف
      if (global.gc) {
        global.gc();
      }
    }

    // ===== حفظ الملف النهائي مع تحسين الحجم =====
    console.log(`📄 حفظ الملف النهائي (${pageCount} صفحات)...`);
    
    const mergedBytes = await mergedPdf.save({
      useObjectStreams: false,
      addDefaultPage: false,
      objectsPerTick: 50, // تقليل الذاكرة المؤقتة
      updateFieldAppearances: false
    });

    // تحرير الذاكرة من المستند المؤقت
    mergedPdf.removeAllPages();
    if (global.gc) {
      global.gc();
    }

    // ===== إرسال الملف =====
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const finalMemory = process.memoryUsage();

    console.log(`✅ اكتمل الدمج في ${processingTime} ثانية`);
    console.log(`💾 الذاكرة النهائية: ${Math.round(finalMemory.rss / 1024 / 1024)} MB`);
    console.log(`📦 حجم الملف الناتج: ${Math.round(mergedBytes.length / 1024)} KB`);

    // إرسال الملف
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=merged_${Date.now()}.pdf`);
    res.setHeader('X-Processing-Time', processingTime);
    res.setHeader('X-Page-Count', pageCount);
    res.setHeader('X-Files-Merged', req.files.length);
    
    res.send(Buffer.from(mergedBytes));

    // تنظيف نهائي
    mergedBytes.length = 0;

  } catch (error) {
    console.error('❌ خطأ في الدمج:', error);
    
    // تنظيف الذاكرة في حالة الخطأ
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
    uptime: process.uptime(),
    version: process.version,
    platform: process.platform
  });
});

// ===== نقطة نهاية لتنظيف الذاكرة =====
app.post('/cleanup', (req, res) => {
  if (global.gc) {
    global.gc();
    res.json({ success: true, message: 'تم تنظيف الذاكرة' });
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
╔═══════════════════════════════════════╗
║  🚀 PDF Merger Server v2.0          ║
╠═══════════════════════════════════════╣
║  📡 المنفذ: ${PORT.toString().padEnd(20)}║
║  💾 الذاكرة: ${Math.round(mem.rss / 1024 / 1024)} MB${' '.repeat(15)}║
║  📦 الحد الأقصى للملفات: ${MAX_FILES}${' '.repeat(14)}║
║  📄 الحد الأقصى للحجم: ${MAX_FILE_SIZE / 1024 / 1024} MB${' '.repeat(12)}║
╚═══════════════════════════════════════╝
  `);
});

// ===== تنظيف الذاكرة بشكل دوري =====
setInterval(() => {
  if (global.gc) {
    global.gc();
  }
  const mem = process.memoryUsage();
  console.log(`🧹 تنظيف الذاكرة: ${Math.round(mem.rss / 1024 / 1024)} MB مستخدمة`);
}, 60000); // كل دقيقة
