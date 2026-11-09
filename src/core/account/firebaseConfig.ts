/// The Firebase project Quill's optional account lives in.
///
/// Carried over from `GoogleService-Info.plist` in the macOS app — the same
/// file is kept untouched in `firebase/` beside this project — so a Windows PC
/// and a Mac signed into one account talk to ONE project and see one set of
/// documents. Only the two values the REST APIs need are read; the rest of the
/// plist is what a native Firebase SDK wants and nothing here is one.
///
/// The API key is not a secret the way the NIM key is: it identifies the
/// Firebase *project*, and access is controlled by the security rules deployed
/// alongside it (`firebase/firestore.rules`), not by hiding this string.
/// Google's own documentation says so explicitly; it is why this is committed
/// to the repository and the NIM key never is.
export interface FirebaseConfig {
  apiKey: string;
  projectID: string;
}

export const FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: 'AIzaSyCihdz-JDK-5bWbValegB4Li4tTTSU_5XQ',
  projectID: 'quill-dictation-app',
};

export const IDENTITY_TOOLKIT = 'https://identitytoolkit.googleapis.com/v1';
export const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
export const FIRESTORE = 'https://firestore.googleapis.com/v1';
