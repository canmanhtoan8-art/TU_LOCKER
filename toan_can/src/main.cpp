#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>

// WIFI
#define WIFI_SSID "Manh Toan"
#define WIFI_PASSWORD "04082004"

// FIREBASE
#define API_KEY "AIzaSyBk8q8424cAv3CXA4OkxokHhC4-7Vpo0vc"
#define DATABASE_URL "https://tu-lan-2-default-rtdb.firebaseio.com"

// RELAY PINS
#define RELAY_1 4
#define RELAY_2 16
#define RELAY_3 17
#define RELAY_4 18
#define RELAY_5 5
#define RELAY_6 19
#define RELAY_7 21
#define RELAY_8 22

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

const int lockerIds[] = {1, 2, 3, 4, 5, 6, 7, 8};
const int relayPins[] = {
  RELAY_1,
  RELAY_2,
  RELAY_3,
  RELAY_4,
  RELAY_5,
  RELAY_6,
  RELAY_7,
  RELAY_8
};

const int LOCKER_COUNT = 8;

void openLocker(int lockerId, int relayPin) {
  Serial.print("Mo cua tu ");
  Serial.println(lockerId);

  digitalWrite(relayPin, HIGH);
  delay(5000);
  digitalWrite(relayPin, LOW);

  String path = "locker/" + String(lockerId) + "/open";
  Firebase.RTDB.setBool(&fbdo, path.c_str(), false);
}

void setup() {
  Serial.begin(115200);

  for (int i = 0; i < LOCKER_COUNT; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], LOW);
  }

  // KET NOI WIFI
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected");

  // FIREBASE CONFIG
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase signup OK");
  } 
  else {
    Serial.printf("Signup error: %s\n", config.signer.signupError.message.c_str());
  }

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.println("Firebase ready");
}

void loop() {
  for (int i = 0; i < LOCKER_COUNT; i++) {
    int lockerId = lockerIds[i];
    int relayPin = relayPins[i];

    String path = "locker/" + String(lockerId) + "/open";

    if (Firebase.RTDB.getBool(&fbdo, path.c_str())) {
      bool status = fbdo.boolData();

      Serial.print("Locker ");
      Serial.print(lockerId);
      Serial.print(" status: ");
      Serial.println(status);

      if (status == true) {
        openLocker(lockerId, relayPin);
      }
    } 
    else {
      Serial.print("Firebase error at ");
      Serial.print(path);
      Serial.print(": ");
      Serial.println(fbdo.errorReason());
    }
  }

  delay(300);
}