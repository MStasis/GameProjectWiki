# Title:Placeholder

SF 루트슈터 게임의 아이템, 시스템, 세계관과 이상 현상을 정리하는 개인용 위키입니다. 방문자는 게시된 문서를 자유롭게 열람하고, 관리자 계정만 문서를 작성·편집·게시할 수 있습니다.

## 주요 기능

- 임의 깊이의 분류·문서 트리와 순서 변경
- 초안 자동 저장, 게시본 분리, 수정 이력과 복원
- 휴지통 방식 삭제와 복구
- 서식 텍스트, 이미지, YouTube, Google Sheets, 경고 상자 블록
- 제목·본문·태그 검색
- 무기·이상 현상·시스템 문서 템플릿
- PC와 모바일에 최적화된 반응형 UI
- 업로드 파일 검증, HTML 정제, 제한된 외부 임베드

## 로컬 실행

Python 3.12 이상을 권장합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다. 관리자 계정은 `/login/`에서 로그인합니다. 공개 회원가입 기능은 없습니다.

화면 확인용 예시 문서가 필요하면 아래 명령을 사용할 수 있습니다. 이 명령은 선택 사항이며 반복 실행해도 같은 제목의 데모 문서를 중복 생성하지 않습니다.

```powershell
python manage.py seed_demo --username operator --password "로컬에서만-쓸-비밀번호"
```

## 검증

```powershell
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
node --check wiki/static/wiki/js/site.js
node --check wiki/static/wiki/js/editor.js
node --check wiki/static/wiki/js/tree.js
```

## 환경 변수

`.env.example`을 참고하세요. 운영 환경에서는 반드시 다음 값을 별도로 설정해야 합니다.

- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG=false`
- `DJANGO_ALLOWED_HOSTS`
- `DATABASE_URL`
- `SITE_TITLE`

비밀번호, 데이터베이스, 업로드 이미지와 실제 `.env` 파일은 Git에 커밋하지 않습니다.

## Docker

`docker-compose.yml`은 Django, PostgreSQL과 영구 미디어 볼륨을 함께 실행합니다. 운영 전에 예시 비밀번호와 호스트 설정을 반드시 바꾸세요.

```powershell
docker compose up --build
docker compose exec web python manage.py createsuperuser
```

## Google Sheets

Google Sheets 블록에는 웹에 게시된 스프레드시트 링크와 `A1:H30` 형식의 범위를 입력합니다. 시트 자체의 공개 설정은 Google에서 관리되며, 민감한 데이터는 게시하지 마세요.

## 데이터 보관

Git 저장소에는 애플리케이션 코드만 들어갑니다. 운영 시 PostgreSQL과 `media` 볼륨을 함께 백업해야 하며, 페이지 수정 이력은 시스템 전체 백업을 대신하지 않습니다.
