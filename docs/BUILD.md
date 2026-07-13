# 빌드 안내서

## 요구 환경

공통:

- Windows 10/11 x64
- Node.js 22 LTS 이상
- npm 10 이상
- PowerShell 7 권장

Android 추가 요구 사항:

- Android Studio
- Android Studio에 포함된 Java 21 JBR
- Android SDK, Platform Tools, 현재 Android 플랫폼과 Build Tools
- 기본 SDK 위치: `%LOCALAPPDATA%\Android\Sdk`
- 기본 JBR 위치: `C:\Program Files\Android\Android Studio\jbr`

빌드 스크립트는 위 기본 경로를 사용합니다. 다른 위치에 설치했다면 `scripts/build-android.ps1`의 경로를 환경에 맞게 조정합니다. 시스템 기본 Java가 8이어도 스크립트가 Android Studio의 Java 21을 명시적으로 사용합니다.

## 의존성 설치와 개발 실행

```powershell
npm ci
npm run dev
```

개발 서버는 기본적으로 `http://127.0.0.1:5173`에서 실행됩니다. 데이터는 개발 브라우저의 IndexedDB에 저장되므로 테스트 데이터를 운영 데이터로 간주하지 마세요.

## 검증

```powershell
npm run test
npm run build
npm run check
npm audit
```

`npm run check`는 테스트 후 정적 앱 빌드를 실행합니다. 설치 패키지를 만들기 전에 실패 항목을 모두 해결합니다.

## Windows EXE 생성

```powershell
.\scripts\build-desktop.ps1
```

스크립트는 다음 작업을 수행합니다.

1. Vite 정적 앱 빌드
2. Electron/NSIS Windows x64 설치 프로그램 빌드
3. 최신 설치 파일을 `artifacts`로 복사
4. SHA-256 출력

최종 파일:

```text
artifacts/Title-Placeholder-Wiki-Setup-2.0.0.exe
```

직접 `npm run desktop:build`를 실행하면 원본 결과는 `release`에 생성되지만 `artifacts` 복사 단계는 수행하지 않습니다.

현재 EXE에는 상용 Authenticode 코드 서명이 없습니다. 릴리스 노트에 SHA-256 값을 적고 SmartScreen 경고 가능성을 명시해야 합니다.

## Android APK 생성

Android Studio를 한 번 실행해 SDK 구성 요소와 라이선스 설정을 마친 뒤 실행합니다.

```powershell
.\scripts\build-android.ps1
```

스크립트는 다음 작업을 수행합니다.

1. Java 21과 Android SDK 환경 변수 설정
2. 저장소에 포함된 Capacitor Android 프로젝트와 서명 안전장치 확인
3. 최초 빌드라면 `build-secrets`에 릴리스 키와 서명 속성 생성
4. Vite 빌드 결과를 Android 프로젝트와 동기화
5. Gradle `assembleRelease` 실행
6. APK를 `artifacts`로 복사하고 SHA-256 출력

최종 파일:

```text
artifacts/Title-Placeholder-Wiki-Android-v2.0.0.apk
```

### Android 서명 키

최초 빌드에서 생성되는 두 파일은 절대 Git에 커밋하지 않습니다.

```text
build-secrets/title-placeholder-wiki-release.jks
build-secrets/android-signing.properties
```

암호화된 오프라인 저장소에 두 파일을 함께 백업하세요. 키를 잃으면 기존 앱 위에 새 APK를 업데이트할 수 없습니다. 사용자는 JSON 내보내기 후 기존 앱을 제거해야 할 수 있으며, 제거 과정에서 로컬 데이터가 지워질 수 있습니다.

동일한 앱 ID `com.mstasis.titleplaceholderwiki`와 동일한 키를 유지해야 업데이트 설치가 가능합니다.

첫 서명 빌드는 공개 가능한 인증서 SHA-256 지문을 `build/android-signing-certificate.sha256`에 기록합니다. 이후 이 파일은 APK가 같은 키로 서명됐는지 검사하는 기준이 됩니다. 지문 파일이 있는데 개인 키가 없으면 스크립트는 새 키를 만들지 않고 중단하므로, `build-secrets` 백업을 복원해야 합니다.

## 전체 빌드

```powershell
.\scripts\build-all.ps1
```

테스트와 정적 빌드 검증 후 Windows EXE와 Android APK를 차례로 만듭니다.

## 릴리스 절차

1. `npm run check`가 통과하는지 확인합니다.
2. 두 설치 파일을 생성합니다.
3. 파일 크기와 SHA-256을 기록합니다.
4. 가능하면 깨끗한 Windows 사용자 환경과 Android 실기기에서 설치·실행·동기화를 확인합니다.
5. Git 태그와 GitHub Release를 만듭니다.
6. EXE와 APK를 Release 자산으로 첨부하고 SHA-256을 릴리스 노트에 적습니다.

`artifacts/`, `release/`, `build-secrets/`, Android 빌드 출력은 `.gitignore` 대상입니다. 설치 파일과 서명 키를 소스 커밋에 강제로 추가하지 마세요.

## 자주 발생하는 빌드 문제

- **Java 버전 오류:** `java -version`보다 `C:\Program Files\Android\Android Studio\jbr\bin\java.exe -version`이 21인지 확인합니다.
- **SDK를 찾지 못함:** Android Studio의 SDK Manager에서 위치를 확인하고 스크립트 경로를 맞춥니다.
- **Gradle 라이선스 오류:** Android Studio SDK Manager나 `sdkmanager --licenses`로 필요한 라이선스를 승인합니다.
- **APK 업데이트 거부:** 이전 APK와 현재 APK의 서명 키가 다른 경우입니다. 기존 릴리스 키를 복원합니다.
- **SmartScreen 경고:** 코드 서명되지 않은 개인 배포 EXE의 예상 동작입니다. 해시 확인 절차를 생략하지 마세요.
