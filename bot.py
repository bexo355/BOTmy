import os
import logging
import tempfile
from telethon import TelegramClient, events
from telethon.tl.types import DocumentAttributeFilename
from pypdf import PdfMerger
import asyncio
import aiofiles

# --- الإعدادات ---
API_ID = int(os.environ.get("API_ID", 0))  # من my.telegram.org
API_HASH = os.environ.get("API_HASH", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")  # اختياري للبوت

if not API_ID or not API_HASH:
    raise ValueError("Please set API_ID and API_HASH environment variables")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- تخزين مؤقت لكل مستخدم ---
user_data = {}  # {user_id: {'files': [paths]}}

# --- إنشاء العميل (حساب مستخدم) ---
client = TelegramClient('session', API_ID, API_HASH)

# --- دوال المساعدة ---
async def is_valid_pdf(file_path: str) -> bool:
    """التحقق من صحة ملف PDF"""
    try:
        async with aiofiles.open(file_path, 'rb') as f:
            header = await f.read(5)
            return header == b'%PDF-'
    except:
        return False

async def merge_pdfs_files(files: list) -> str:
    """دمج ملفات PDF"""
    merger = PdfMerger()
    for f in files:
        merger.append(f)
    
    output_path = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf").name
    merger.write(output_path)
    merger.close()
    return output_path

# --- معالجة الأوامر ---
@client.on(events.NewMessage(pattern='/start'))
async def start(event):
    await event.reply(
        "📚 **بوت دمج ملفات PDF (بدون حد 50 ميجابايت)**\n\n"
        "✅ يمكنك إرسال ملفات PDF بأي حجم (حتى 2 جيجابايت)\n"
        "📌 أرسل الملفات واحدة تلو الأخرى\n"
        "🔗 استخدم /merge لدمج الملفات\n"
        "❌ استخدم /cancel لإلغاء العملية\n"
        "📋 استخدم /list لعرض الملفات المرفوعة"
    )

@client.on(events.NewMessage(pattern='/cancel'))
async def cancel(event):
    user_id = event.sender_id
    if user_id in user_data:
        # حذف الملفات المؤقتة
        for file_path in user_data[user_id]['files']:
            try:
                os.remove(file_path)
            except:
                pass
        del user_data[user_id]
    await event.reply("❌ تم إلغاء العملية ومسح جميع الملفات.")

@client.on(events.NewMessage(pattern='/list'))
async def list_files(event):
    user_id = event.sender_id
    if user_id not in user_data:
        await event.reply("📭 لم تقم برفع أي ملفات بعد.")
        return
    
    files = user_data[user_id]['files']
    sizes = []
    for f in files:
        size_mb = os.path.getsize(f) / (1024 * 1024)
        sizes.append(f"{size_mb:.2f} MB")
    
    msg = f"📦 **الملفات المرفوعة:** {len(files)}\n\n"
    for i, size in enumerate(sizes, 1):
        msg += f"{i}. حجم: {size}\n"
    
    await event.reply(msg)

@client.on(events.NewMessage(pattern='/merge'))
async def merge_command(event):
    user_id = event.sender_id
    
    if user_id not in user_data or not user_data[user_id]['files']:
        await event.reply("⚠️ لم تقم برفع أي ملفات PDF بعد. أرسل الملفات أولاً.")
        return
    
    files = user_data[user_id]['files']
    if len(files) < 2:
        await event.reply("⚠️ تحتاج إلى ملفين على الأقل للدمج.")
        return
    
    # حساب الحجم الكلي
    total_size = sum(os.path.getsize(f) for f in files) / (1024 * 1024)
    
    await event.reply(
        f"⏳ جاري دمج {len(files)} ملف...\n"
        f"📦 الحجم الكلي: {total_size:.2f} MB\n"
        "قد يستغرق هذا بعض الوقت للملفات الكبيرة."
    )
    
    try:
        # دمج الملفات
        output_path = await merge_pdfs_files(files)
        output_size = os.path.getsize(output_path) / (1024 * 1024)
        
        # إرسال الملف المدمج (حتى 2 جيجابايت مسموح)
        await event.reply(
            f"✅ تم الدمج بنجاح!\n"
            f"📦 الحجم: {output_size:.2f} MB\n"
            f"⏳ جاري رفع الملف..."
        )
        
        # إرسال الملف عبر Telethon (يدعم حتى 2 جيجابايت)
        await client.send_file(
            event.chat_id,
            output_path,
            caption=f"✅ تم دمج {len(files)} ملف بنجاح!",
            force_document=True,
            attributes=[DocumentAttributeFilename("merged_file.pdf")]
        )
        
        # تنظيف الملفات المؤقتة
        for f in files:
            try:
                os.remove(f)
            except:
                pass
        os.remove(output_path)
        del user_data[user_id]
        
    except Exception as e:
        await event.reply(f"❌ خطأ أثناء الدمج: {str(e)}")
        # تنظيف
        for f in files:
            try:
                os.remove(f)
            except:
                pass
        if user_id in user_data:
            del user_data[user_id]

# --- معالجة الملفات المرفوعة ---
@client.on(events.NewMessage)
async def handle_file(event):
    # تجاهل الأوامر
    if event.message.text and event.message.text.startswith('/'):
        return
    
    # التأكد من وجود ملف
    if not event.message.document:
        return
    
    user_id = event.sender_id
    document = event.message.document
    
    # التحقق من أن الملف PDF
    if document.mime_type != "application/pdf":
        await event.reply("⚠️ الرجاء إرسال ملف PDF فقط.")
        return
    
    # الحصول على حجم الملف
    file_size_mb = document.size / (1024 * 1024)
    
    await event.reply(
        f"⏳ جاري تحميل الملف...\n"
        f"📦 الحجم: {file_size_mb:.2f} MB"
    )
    
    try:
        # تحميل الملف (يدعم أي حجم)
        temp_path = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf").name
        
        # تحميل الملف باستخدام Telethon
        await client.download_media(
            event.message.document,
            file=temp_path
        )
        
        # التحقق من صحة الملف
        if not await is_valid_pdf(temp_path):
            os.remove(temp_path)
            await event.reply("❌ الملف ليس PDF صالح.")
            return
        
        # تخزين الملف
        if user_id not in user_data:
            user_data[user_id] = {'files': []}
        user_data[user_id]['files'].append(temp_path)
        
        # حساب إجمالي الملفات
        total_files = len(user_data[user_id]['files'])
        total_size = sum(os.path.getsize(f) for f in user_data[user_id]['files']) / (1024 * 1024)
        
        await event.reply(
            f"✅ تم رفع الملف بنجاح!\n"
            f"📦 عدد الملفات: {total_files}\n"
            f"📦 إجمالي الحجم: {total_size:.2f} MB\n\n"
            "أرسل ملف آخر أو استخدم /merge للدمج."
        )
        
    except Exception as e:
        await event.reply(f"❌ خطأ في التحميل: {str(e)}")

# --- تشغيل البوت ---
async def main():
    await client.start()
    logger.info("✅ البوت يعمل الآن... (يدعم الملفات حتى 2 جيجابايت)")
    await client.run_until_disconnected()

if __name__ == "__main__":
    asyncio.run(main())
