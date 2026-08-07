#!/usr/bin/env python3
"""
توليد تقرير نتائج الأسبوع الماضي من ورقة الأرشيف
مع ربط الأرقام بالأسماء من ورقة المسجلين
وكتابة التقرير في ورقة "نهاية الأسبوع"
"""

import json
import os
import sys
import re
from datetime import datetime, date
from collections import defaultdict
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'
AUTH_DIR = '/home/ubuntu/AbuSaif'
ARCHIVE_SHEET = 'أرشيف-2026-08'
REPORT_SHEET = 'نهاية الأسبوع'
REGISTERED_SHEET = 'المسجلين'
WEEK_LABEL = '01-08-2026 إلى 07-08-2026'

def load_credentials():
    token_path = os.path.join(AUTH_DIR, 'token.json')
    creds_path = os.path.join(AUTH_DIR, 'oauth-credentials.json')
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
        creds.refresh(Request())
    return creds

def safe_int(val):
    try:
        v = str(val).strip().replace(',', '')
        return int(float(v)) if v else 0
    except:
        return 0

def normalize_phone(phone):
    """تطبيع رقم الهاتف"""
    p = str(phone).strip()
    # إزالة + في البداية
    p = p.lstrip('+')
    # إزالة 962 من البداية إذا كان الرقم يبدأ بها
    if p.startswith('962') and len(p) > 9:
        return p[3:]
    return p

def load_registered_members(sheets_service):
    """تحميل ورقة المسجلين لربط الأرقام بالأسماء"""
    print(f'📖 تحميل ورقة المسجلين...')
    result = sheets_service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range=f"'{REGISTERED_SHEET}'"
    ).execute()
    
    rows = result.get('values', [])
    phone_to_name = {}
    
    for row in rows:
        if len(row) < 2:
            continue
        phone = str(row[0]).strip()
        name = str(row[1]).strip() if len(row) > 1 else ''
        if phone and name and phone not in ['الهاتف', 'رقم الهاتف', 'A']:
            # تخزين بأشكال متعددة
            normalized = normalize_phone(phone)
            phone_to_name[phone] = name
            phone_to_name[normalized] = name
            if not phone.startswith('962'):
                phone_to_name['962' + phone] = name
    
    print(f'  ✅ {len(phone_to_name)//2} عضو مسجل')
    return phone_to_name

def get_name(phone, phone_to_name):
    """الحصول على اسم الكابتن من رقم الهاتف"""
    p = str(phone).strip()
    if p in phone_to_name:
        return phone_to_name[p]
    normalized = normalize_phone(p)
    if normalized in phone_to_name:
        return phone_to_name[normalized]
    # اختصار الرقم للعرض
    if len(p) > 7:
        return p[-7:]
    return p

def parse_archive(rows):
    """
    تحليل بيانات الأرشيف واستخراج ملخص لكل جروب
    """
    # {group_name: {phone: {production, reception}}}
    groups = {}
    current_group = None
    in_data = False

    for row in rows:
        if not row:
            in_data = False
            continue
        
        first = str(row[0]).strip() if row else ''
        
        # رأس الورقة (=== اسم الورقة ===)
        if first.startswith('===') and first.endswith('==='):
            sheet_name = first.strip('= ').strip()
            # استخراج اسم الجروب
            match = re.match(r'^([^\-]+)-\d{4}-\d{2}-\d{2}$', sheet_name)
            if match:
                current_group = match.group(1).strip()
            else:
                # ورقة بتاريخ فقط
                current_group = 'دريمكس'  # افتراضي للورقة 2026-08-04
            
            if current_group not in groups:
                groups[current_group] = {}
            in_data = False
            continue
        
        # البحث عن صف الرأس
        if current_group and not in_data:
            row_text = ' '.join(str(c) for c in row)
            if any(x in row_text for x in ['الانتاج', 'الإنتاج', 'إنتاج', 'الاستلام']):
                in_data = True
                continue
        
        # صفوف البيانات
        if current_group and in_data and len(row) >= 3:
            phone = str(row[0]).strip()
            
            # تجاهل الصفوف غير الصالحة
            if not phone or any(x in phone for x in ['إجمالي', 'المجموع', 'الهاتف', '===', 'الكابتن']):
                continue
            
            prod = safe_int(row[1]) if len(row) > 1 else 0
            recv = safe_int(row[2]) if len(row) > 2 else 0
            
            if phone not in groups[current_group]:
                groups[current_group][phone] = {'production': 0, 'reception': 0}
            
            groups[current_group][phone]['production'] += prod
            groups[current_group][phone]['reception'] += recv
    
    return groups

def build_report_data(groups, phone_to_name):
    """بناء بيانات التقرير الأسبوعي"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    
    report_rows = []
    
    # عنوان التقرير
    report_rows.append(['📊 تقرير نتائج الأسبوع الماضي'])
    report_rows.append([f'الفترة: {WEEK_LABEL}'])
    report_rows.append([f'تاريخ التوليد: {now}'])
    report_rows.append([])
    
    group_order = ['دريمكس', 'نشامى', 'السيف']
    
    for group_name in group_order:
        if group_name not in groups:
            continue
        
        members = groups[group_name]
        if not members:
            continue
        
        # حساب الإجماليات
        total_prod = sum(v['production'] for v in members.values())
        total_recv = sum(v['reception'] for v in members.values())
        
        # رأس الجروب
        report_rows.append([f'═══ {group_name} ═══'])
        report_rows.append([f'إجمالي الإنتاج: {total_prod}', f'إجمالي الاستلام: {total_recv}'])
        report_rows.append([])
        report_rows.append(['الكابتن', 'الإنتاج', 'الاستلام', 'الرصيد'])
        
        # ترتيب حسب الإنتاج تنازلياً
        sorted_members = sorted(
            members.items(),
            key=lambda x: (x[1]['production'], x[1]['reception']),
            reverse=True
        )
        
        rank = 1
        for phone, stats in sorted_members:
            prod = stats['production']
            recv = stats['reception']
            balance = prod - recv
            
            if prod == 0 and recv == 0:
                continue
            
            name = get_name(phone, phone_to_name)
            report_rows.append([name, prod, recv, balance])
            rank += 1
        
        # إجمالي الجروب
        report_rows.append([])
        report_rows.append(['الإجمالي', total_prod, total_recv, total_prod - total_recv])
        report_rows.append([])
        report_rows.append([])
    
    # ملخص عام
    report_rows.append(['═══ ملخص عام ═══'])
    report_rows.append(['الجروب', 'إجمالي الإنتاج', 'إجمالي الاستلام', 'الرصيد'])
    
    grand_prod = 0
    grand_recv = 0
    
    for group_name in group_order:
        if group_name not in groups:
            continue
        members = groups[group_name]
        total_prod = sum(v['production'] for v in members.values())
        total_recv = sum(v['reception'] for v in members.values())
        grand_prod += total_prod
        grand_recv += total_recv
        report_rows.append([group_name, total_prod, total_recv, total_prod - total_recv])
    
    report_rows.append(['الإجمالي الكلي', grand_prod, grand_recv, grand_prod - grand_recv])
    
    return report_rows

def main():
    print('🔄 تحميل المصادقة...')
    creds = load_credentials()
    sheets_service = build('sheets', 'v4', credentials=creds)
    
    # تحميل ورقة المسجلين
    phone_to_name = load_registered_members(sheets_service)
    
    # قراءة ورقة الأرشيف
    print(f'\n📖 قراءة ورقة "{ARCHIVE_SHEET}"...')
    result = sheets_service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range=f"'{ARCHIVE_SHEET}'"
    ).execute()
    rows = result.get('values', [])
    print(f'  ✅ {len(rows)} صف')
    
    # تحليل البيانات
    print('\n🔍 تحليل البيانات...')
    groups = parse_archive(rows)
    
    # بناء بيانات التقرير
    print('\n📊 بناء التقرير الأسبوعي...')
    report_data = build_report_data(groups, phone_to_name)
    
    # طباعة ملخص
    print('\n📋 ملخص النتائج:')
    group_order = ['دريمكس', 'نشامى', 'السيف']
    for group_name in group_order:
        if group_name not in groups:
            continue
        members = groups[group_name]
        active = {p: v for p, v in members.items() if v['production'] > 0 or v['reception'] > 0}
        total_prod = sum(v['production'] for v in active.values())
        total_recv = sum(v['reception'] for v in active.values())
        print(f'  {group_name}: {len(active)} كابتن نشط | إنتاج={total_prod} | استلام={total_recv}')
    
    # التحقق من وجود ورقة التقرير
    print(f'\n📁 التحقق من ورقة "{REPORT_SHEET}"...')
    spreadsheet = sheets_service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID
    ).execute()
    
    report_sheet_id = None
    for sheet in spreadsheet.get('sheets', []):
        if sheet['properties']['title'] == REPORT_SHEET:
            report_sheet_id = sheet['properties']['sheetId']
            break
    
    if report_sheet_id is None:
        print(f'  ➕ إنشاء ورقة "{REPORT_SHEET}"...')
        result = sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={
                'requests': [{
                    'addSheet': {
                        'properties': {
                            'title': REPORT_SHEET,
                            'tabColor': {'red': 0.2, 'green': 0.7, 'blue': 0.3}
                        }
                    }
                }]
            }
        ).execute()
        report_sheet_id = result['replies'][0]['addSheet']['properties']['sheetId']
        print(f'  ✅ تم إنشاء الورقة')
    else:
        # مسح البيانات القديمة
        print(f'  🗑️ مسح البيانات القديمة...')
        sheets_service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=f"'{REPORT_SHEET}'"
        ).execute()
    
    # كتابة التقرير
    print(f'\n✍️ كتابة التقرير في ورقة "{REPORT_SHEET}"...')
    sheets_service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f"'{REPORT_SHEET}'!A1",
        valueInputOption='RAW',
        body={'values': report_data}
    ).execute()
    print(f'  ✅ تم كتابة {len(report_data)} صف')
    
    # تنسيق الورقة
    print('\n🎨 تنسيق الورقة...')
    format_requests = []
    
    # تنسيق صف العنوان (صف 1)
    format_requests.append({
        'repeatCell': {
            'range': {
                'sheetId': report_sheet_id,
                'startRowIndex': 0,
                'endRowIndex': 1,
                'startColumnIndex': 0,
                'endColumnIndex': 4
            },
            'cell': {
                'userEnteredFormat': {
                    'backgroundColor': {'red': 0.2, 'green': 0.4, 'blue': 0.8},
                    'textFormat': {
                        'foregroundColor': {'red': 1, 'green': 1, 'blue': 1},
                        'bold': True,
                        'fontSize': 14
                    },
                    'horizontalAlignment': 'CENTER'
                }
            },
            'fields': 'userEnteredFormat'
        }
    })
    
    # تعيين عرض الأعمدة
    format_requests.append({
        'updateDimensionProperties': {
            'range': {
                'sheetId': report_sheet_id,
                'dimension': 'COLUMNS',
                'startIndex': 0,
                'endIndex': 1
            },
            'properties': {'pixelSize': 200},
            'fields': 'pixelSize'
        }
    })
    for col in [1, 2, 3]:
        format_requests.append({
            'updateDimensionProperties': {
                'range': {
                    'sheetId': report_sheet_id,
                    'dimension': 'COLUMNS',
                    'startIndex': col,
                    'endIndex': col + 1
                },
                'properties': {'pixelSize': 120},
                'fields': 'pixelSize'
            }
        })
    
    if format_requests:
        sheets_service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={'requests': format_requests}
        ).execute()
        print('  ✅ تم التنسيق')
    
    print(f'\n🎉 اكتمل التقرير الأسبوعي!')
    print(f'🔗 https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}')

if __name__ == '__main__':
    main()
