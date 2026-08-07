#!/usr/bin/env python3
"""
أرشفة أوراق الأسبوع القديم (01-08 إلى 07-08-2026) داخل نفس الشيت
بإنشاء ورقة ملخص "أرشيف-2026-08" ثم حذف الأوراق اليومية القديمة
"""

import json
import os
import sys
import re
import time
from datetime import datetime, date
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# إعدادات
SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'
AUTH_DIR = '/home/ubuntu/AbuSaif'
ARCHIVE_SHEET_NAME = 'أرشيف-2026-08'

# الأوراق الثابتة التي يجب الاحتفاظ بها (لا تُحذف أبداً)
KEEP_SHEETS = {
    'الرئيسية', 'المسجلين', 'أرقام غير مسجلة', 'سجل التعديلات',
    'المحذوف', 'Members', 'الإعدادات', 'الحساب الأسبوعي',
    'نهاية الأسبوع', ARCHIVE_SHEET_NAME
}

# تاريخ بداية الأسبوع الجديد
NEW_WEEK_START = date(2026, 8, 8)

def load_credentials():
    """تحميل بيانات المصادقة"""
    token_path = os.path.join(AUTH_DIR, 'token.json')
    creds_path = os.path.join(AUTH_DIR, 'oauth-credentials.json')
    
    if not os.path.exists(token_path):
        print(f'❌ لم يُجد ملف token.json في {token_path}')
        sys.exit(1)
    
    with open(token_path) as f:
        token_data = json.load(f)
    
    with open(creds_path) as f:
        creds_data = json.load(f)
    
    client_config = creds_data.get('web') or creds_data.get('installed', {})
    
    creds = Credentials(
        token=token_data.get('access_token'),
        refresh_token=token_data.get('refresh_token'),
        token_uri='https://oauth2.googleapis.com/token',
        client_id=client_config.get('client_id'),
        client_secret=client_config.get('client_secret'),
        scopes=token_data.get('scope', 'https://www.googleapis.com/auth/spreadsheets').split()
    )
    
    if creds.expired and creds.refresh_token:
        print('🔄 تجديد التوكن...')
        creds.refresh(Request())
        with open(token_path, 'w') as f:
            json.dump({
                'access_token': creds.token,
                'refresh_token': creds.refresh_token,
                'token_uri': creds.token_uri,
                'client_id': creds.client_id,
                'client_secret': creds.client_secret,
                'scope': ' '.join(creds.scopes),
                'expiry_date': int(creds.expiry.timestamp() * 1000) if creds.expiry else None
            }, f)
    
    return creds

def is_old_week_sheet(sheet_name):
    """تحديد ما إذا كانت الورقة تنتمي للأسبوع القديم"""
    if sheet_name in KEEP_SHEETS:
        return False
    
    # البحث عن تاريخ في اسم الورقة
    # صيغ محتملة: دريمكس-01-08-2026 أو دريمكس-2026-08-01
    
    # صيغة DD-MM-YYYY
    match = re.search(r'(\d{2})-(\d{2})-(\d{4})', sheet_name)
    if match:
        day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
        try:
            sheet_date = date(year, month, day)
            return sheet_date < NEW_WEEK_START
        except:
            pass
    
    # صيغة YYYY-MM-DD
    match = re.search(r'(\d{4})-(\d{2})-(\d{2})', sheet_name)
    if match:
        year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
        try:
            sheet_date = date(year, month, day)
            return sheet_date < NEW_WEEK_START
        except:
            pass
    
    return False

def get_sheet_data(sheets_service, spreadsheet_id, sheet_name):
    """جلب بيانات ورقة كاملة"""
    try:
        result = sheets_service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'"
        ).execute()
        return result.get('values', [])
    except Exception as e:
        print(f'  ⚠️ فشل جلب بيانات {sheet_name}: {e}')
        return []

def main():
    print('🔄 جاري تحميل بيانات المصادقة...')
    creds = load_credentials()
    
    sheets_service = build('sheets', 'v4', credentials=creds)
    
    # جلب قائمة الأوراق الحالية
    print('📋 جاري جلب قائمة الأوراق...')
    spreadsheet = sheets_service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID
    ).execute()
    
    all_sheets = spreadsheet.get('sheets', [])
    
    # طباعة جميع الأوراق للمراجعة
    print(f'\n📊 إجمالي الأوراق في الشيت: {len(all_sheets)}')
    
    # تحديد الأوراق القديمة
    old_sheets = []
    for sheet in all_sheets:
        name = sheet['properties']['title']
        if is_old_week_sheet(name):
            old_sheets.append({
                'id': sheet['properties']['sheetId'],
                'name': name
            })
    
    if not old_sheets:
        print('\n✅ لا توجد أوراق قديمة للأرشفة')
        print('\nجميع الأوراق الموجودة:')
        for s in all_sheets:
            print(f'  - {s["properties"]["title"]}')
        return
    
    # ترتيب الأوراق القديمة حسب الاسم
    old_sheets.sort(key=lambda x: x['name'])
    
    print(f'\n📂 الأوراق القديمة التي سيتم أرشفتها ({len(old_sheets)} ورقة):')
    for s in old_sheets:
        print(f'  - {s["name"]}')
    
    # جمع بيانات جميع الأوراق القديمة
    print('\n📥 جاري جمع بيانات الأوراق القديمة...')
    all_archive_data = []
    
    for sheet in old_sheets:
        print(f'  📄 جلب بيانات: {sheet["name"]}...')
        data = get_sheet_data(sheets_service, SPREADSHEET_ID, sheet['name'])
        
        # إضافة رأس الورقة
        all_archive_data.append([f'=== {sheet["name"]} ==='])
        
        if data:
            all_archive_data.extend(data)
            print(f'  ✅ {len(data)} صف')
        else:
            all_archive_data.append(['(لا توجد بيانات)'])
            print(f'  ⚠️ ورقة فارغة')
        
        # فراغ بين الأوراق
        all_archive_data.append([])
        all_archive_data.append([])
    
    # إنشاء ورقة الأرشيف أو التحقق من وجودها
    print(f'\n📁 جاري إنشاء ورقة الأرشيف "{ARCHIVE_SHEET_NAME}"...')
    
    # التحقق من وجود ورقة الأرشيف
    archive_sheet_id = None
    for sheet in all_sheets:
        if sheet['properties']['title'] == ARCHIVE_SHEET_NAME:
            archive_sheet_id = sheet['properties']['sheetId']
            print(f'  ℹ️ ورقة الأرشيف موجودة بالفعل (ID: {archive_sheet_id})')
            break
    
    if archive_sheet_id is None:
        # إنشاء ورقة جديدة
        result = sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={
                'requests': [{
                    'addSheet': {
                        'properties': {
                            'title': ARCHIVE_SHEET_NAME,
                            'tabColor': {'red': 0.8, 'green': 0.6, 'blue': 0.2}
                        }
                    }
                }]
            }
        ).execute()
        archive_sheet_id = result['replies'][0]['addSheet']['properties']['sheetId']
        print(f'  ✅ تم إنشاء ورقة الأرشيف (ID: {archive_sheet_id})')
    
    # كتابة رأس الأرشيف
    header_data = [
        [f'أرشيف الأسبوع: 01-08-2026 إلى 07-08-2026'],
        [f'تم الأرشفة في: {datetime.now().strftime("%Y-%m-%d %H:%M")}'],
        [f'عدد الأوراق المؤرشفة: {len(old_sheets)}'],
        [],
        ['الأوراق المؤرشفة:']
    ]
    for s in old_sheets:
        header_data.append([f'  • {s["name"]}'])
    header_data.append([])
    header_data.append(['=' * 50])
    header_data.append([])
    
    # كتابة البيانات في ورقة الأرشيف
    print('\n✍️ جاري كتابة البيانات في ورقة الأرشيف...')
    full_data = header_data + all_archive_data
    
    sheets_service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f"'{ARCHIVE_SHEET_NAME}'!A1",
        valueInputOption='RAW',
        body={'values': full_data}
    ).execute()
    print(f'  ✅ تم كتابة {len(full_data)} صف في ورقة الأرشيف')
    
    # حذف الأوراق القديمة من الشيت الأصلي
    print('\n🗑️ جاري حذف الأوراق القديمة من الشيت الأصلي...')
    
    delete_requests = []
    for sheet in old_sheets:
        delete_requests.append({
            'deleteSheet': {'sheetId': sheet['id']}
        })
    
    if delete_requests:
        sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={'requests': delete_requests}
        ).execute()
        print(f'✅ تم حذف {len(delete_requests)} ورقة من الشيت الأصلي')
    
    print(f'\n🎉 اكتملت الأرشفة بنجاح!')
    print(f'📊 الأوراق المؤرشفة: {len(old_sheets)}')
    print(f'📁 البيانات محفوظة في ورقة: {ARCHIVE_SHEET_NAME}')
    print(f'🔗 رابط الشيت: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}')

if __name__ == '__main__':
    main()
