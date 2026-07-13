# Title:Placeholder Wiki

SF 루트슈터 프로젝트의 아이템, 시스템, 세계관과 이상 현상을 정리하는 개인용 오프라인 위키입니다. Windows PC와 Android 휴대폰에 각각 전체 데이터를 저장하므로 인터넷이나 PC 연결이 없어도 열람·편집할 수 있고, PC가 다시 켜지면 Tailscale을 통해 변경 사항을 합칩니다.

서버 임대나 월 사용료는 필요하지 않습니다. 앱 화면은 정적 HTML/CSS/JavaScript로 구성되고 데이터는 각 기기에만 저장됩니다.

## 설치 파일

GitHub Release에서 다음 두 파일을 받습니다. 빌드 결과물은 용량과 서명 정보 때문에 Git 저장소에는 커밋하지 않고 Release에만 첨부합니다.

- Windows 10/11 x64: `artifacts/Title-Placeholder-Wiki-Setup-2.0.0.exe`
- Android: `artifacts/Title-Placeholder-Wiki-Android-v2.0.0.apk`

Windows 설치 파일은 상용 코드 서명이 없어 SmartScreen 경고가 표시될 수 있습니다. Android APK는 Play 스토어 밖에서 설치하므로 “알 수 없는 앱” 허용 안내가 표시됩니다. 반드시 이 저장소의 공식 Release와 함께 제공된 SHA-256 값을 확인한 뒤 설치하세요.

## 5분 시작

1. PC에 Windows 설치 파일을, 휴대폰에 APK를 설치합니다.
2. [Tailscale](https://tailscale.com/download)을 두 기기에 설치하고 같은 계정으로 로그인합니다.
3. PC 위키 앱을 실행한 뒤 설정에서 **Tailscale 연결/Serve 활성화**를 실행합니다.
4. PC 설정의 **Windows 로그인 시 자동 시작**을 켭니다.
5. PC 화면에 표시된 동기화 URL, 사용자명, 비밀번호를 휴대폰 위키의 동기화 설정에 입력합니다.
6. 휴대폰에서 연결을 확인하고 **지금 동기화**를 누릅니다.

이후 휴대폰은 PC가 꺼져 있어도 계속 편집할 수 있습니다. 변경 내용은 휴대폰에 안전하게 대기하며, PC 앱이 다시 실행되고 두 기기가 Tailscale에 연결되면 수동 또는 자동으로 동기화됩니다.

자세한 설치·편집·백업·충돌 해결 방법은 [사용자 안내서](docs/USER_GUIDE.md)를 참고하세요.

## 주요 기능

- 대주제 → 하위 주제 → 문서를 원하는 깊이로 구성
- 데스크톱 드래그 앤 드롭과 모바일 이동 버튼으로 순서 변경
- 텍스트, 이미지, YouTube, Google Sheets, 강조 상자, 구분선 블록
- 글꼴, 크기, 굵게, 기울임, 밑줄, 정렬, 글자색과 배경색 서식
- 제목·본문·태그 검색, 초안/게시 상태, 휴지통, 수정 이력
- 기기별 완전한 로컬 사본과 오프라인 편집
- 동시 편집을 덮어쓰지 않는 명시적 충돌 보관
- JSON 내보내기/가져오기와 PC 자동 압축 백업
- 모바일·태블릿·데스크톱 반응형 화면

Google Sheets와 YouTube 블록의 실제 외부 콘텐츠는 인터넷 연결이 있어야 표시됩니다. 공개한 Google Sheets 범위는 링크를 아는 외부인이 볼 수 있으므로 민감한 내용을 넣지 마세요.

## 개발

Node.js 22 LTS 이상을 권장합니다.

```powershell
npm ci
npm run dev
```

검증과 두 설치 파일 생성:

```powershell
npm run check
.\scripts\build-all.ps1
```

Android 빌드에는 Java 21과 Android SDK가 추가로 필요합니다. 전체 준비 과정과 서명 키 보관 방법은 [빌드 안내서](docs/BUILD.md), 저장·동기화 설계는 [아키텍처 문서](docs/ARCHITECTURE.md)를 참고하세요.

## 데이터와 보안

위키 본문, 이미지, 동기화 암호와 백업은 Git에 들어가지 않습니다. 동기화 서버는 PC의 로컬 주소에서만 실행되고 Tailscale Serve가 같은 사설 네트워크의 기기에 HTTPS로 전달합니다. 이 앱에는 별도의 회원 계정/권한 시스템이 없으므로 Windows 계정과 휴대폰 화면 잠금을 사용하고 동기화 자격 증명을 공유하지 마세요.

PC 앱은 창을 닫아도 시스템 트레이에서 동기화 호스트로 계속 실행됩니다. 완전히 종료하려면 트레이 메뉴에서 **종료**를 선택합니다.

## 지원 범위

- 지원: Windows 10/11 x64, Android
- 미지원: macOS, Linux 설치 패키지, iOS
- PC가 꺼진 동안 기기 간 실시간 동기화는 불가
- Android 앱을 완전히 종료하면 백그라운드 동기화를 보장하지 않음
- YouTube와 Google Sheets 외부 콘텐츠는 오프라인 재생/표시 불가
