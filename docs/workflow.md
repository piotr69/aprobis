# Obieg i role

## Cykl życia dokumentu

```text
Szkic ──złożenie──> W akceptacji ──ostatnia decyzja──> Zatwierdzony ──> W archiwum
  │                   │  │   │
  │                   │  │   └─odrzucenie──> Odrzucony
  │                   │  └─zwrot──> Do poprawy ──ponowne złożenie──> W akceptacji (od początku)
  └──wycofanie──> Wycofany <──wycofanie── (także z „W akceptacji” i „Do poprawy”)
```

- Treść i załączniki można zmieniać tylko w szkicu i w dokumencie do poprawy.
- Po zwrocie obieg zaczyna się **od początku**, bo zmiana treści lub kwoty może wymagać innej ścieżki.
- Korekta nie jest zadaniem do zatwierdzenia: autor poprawia i składa ponownie.
- Termin każdego etapu liczy się od jego otwarcia. Po terminie worker wysyła jednorazowe przypomnienie.
- Zwrot i odrzucenie wymagają uzasadnienia, które widzi autor.

## Skąd bierze się ścieżka

Przed złożeniem autor widzi na karcie dokumentu, kto będzie akceptować.

1. **Stały schemat typu.** Gdy typ ma aktywny schemat, zawsze obowiązują jego etapy, a reguły są pomijane.
2. **Reguły warunkowe.** Sprawdzane po kolei (kwota, waluta, kategoria, dział, słowa w tytule). Etapy pasujących reguł układają się kolejno. „Nie sprawdzaj kolejnych” kończy przeglądanie.
3. **Domyślnie** akceptuje przełożony autora.

Uszkodzona reguła blokuje złożenie z komunikatem. Nie jest pomijana, bo mogła wymagać dodatkowej akceptacji.

Waluty: PLN, EUR, USD. Progi kwotowe dotyczą PLN, a faktura w walucie obcej przechodzi pełną ścieżkę, bo system nie zna kursów.

## Kto dostaje zadanie

| Etap | Wykonawca |
| --- | --- |
| Przełożony autora | Bezpośredni przełożony |
| Kierownik działu | Kierownik działu autora |
| Rola | Każda osoba z roli (decyduje pierwsza) |
| Konkretna osoba | Wskazana osoba |
| Rola w dziale | Osoby z roli w danym dziale |
| Zarząd | Każdy członek zarządu |

Gdy wyznaczona osoba nie może decydować (autor dokumentu, konto nieaktywne, rola bez prawa decyzji, kwota ponad jej limit), etap idzie do **pierwszego przełożonego wyżej, który może**, a na końcu łańcucha do zarządu. Gdy nie ma nikogo, złożenie kończy się komunikatem: zadanie, którego nikt nie może wykonać, nigdy nie powstaje.

Dział dokumentu ustala serwer z profilu autora, więc autor nie wybierze sobie akceptującego.

## Limity akceptacji

Administrator ustawia każdej osobie w „Użytkownicy”, czy ma limit i jaki. Brak limitu oznacza brak ograniczenia.

- Dokument ponad limit trafia przy składaniu do pierwszego przełożonego wyżej, którego limit wystarcza. Podgląd ścieżki pokazuje tę osobę.
- Zadanie z roli widzą tylko osoby, których limit wystarcza.
- Limit jest sprawdzany także przy decyzji, bo mógł się zmienić po przydzieleniu. Osoba ponad limitem może przekazać zadanie lub zwrócić dokument, ale nie zatwierdzi.
- Przy zastępstwie liczy się limit obu osób. Zadania nie można przekazać komuś z za niskim limitem.
- Limit w innej walucie niż dokument liczy się jako przekroczony, bo system nie zna kursów. Dokument bez kwoty nie przekracza limitu.
- Gdy nikt w łańcuchu i w zarządzie nie ma dość wysokiego limitu, złożenie kończy się komunikatem.

## Role

Prawo do decyzji wynika z **przydzielonego zadania**, a nie z roli. Rola określa, co widać i do czego jest dostęp. Szeroki wgląd nie oznacza przydziału: księgowa widzi fakturę z innego działu, ale nie ma jej na liście „Do zrobienia”. Definicje: `backend/src/shared/roles.ts`.

| Rola | Widzi (złożone dokumenty) | Dodatkowo |
| --- | --- | --- |
| Pracownik, Zakupy, IT | Swoje i te z własnym udziałem | |
| Kierownik działu | + podwładnych i swojego działu | Raporty zbiorcze |
| Księgowość | + wszystkie finansowe | Raporty zbiorcze |
| Dział prawny | + wszystkie umowy | |
| Kadry | + wszystkie kadrowe | Archiwizuje kadrowe |
| Sekretariat | + wszystkie poza kadrowymi | Archiwizuje poza kadrowymi |
| Dyrektor | + wszystkie, także kadrowe | Raporty zbiorcze |
| Zarząd | + wszystkie | Raporty zbiorcze |
| Audytor | Wszystkie, także szkice | Tylko odczyt, raporty pełne (bez dziennika zdarzeń i logów systemowych). Bez decyzji |
| Administrator systemu | Wszystkie, także szkice | Konfiguracja, przepisywanie zadań, wycofywanie. Bez decyzji i edycji cudzej treści |
| Administrator słowników | Swoje i te z własnym udziałem | Typy dokumentów |
| Tylko podgląd | Te z własnym udziałem | Bez tworzenia i decyzji |

Cudzy szkic widzą tylko audytor i administrator. Wycofany szkic, którego nikt nie złożył, pozostaje prywatny.

## Rozdział obowiązków

- Autor nie decyduje o własnym dokumencie w żadnej roli.
- Zastępca przejmuje tylko to, co zastępowany sam może zrobić, więc zastępca autora nie zatwierdzi dokumentu autora.
- Administrator wskazuje wykonawcę, ale nie decyduje. Nie może przepisać zadania na siebie.
- Audytora nie można uczynić wykonawcą, zastępcą ani adresatem przekazania.

## Zastępstwa i przekazanie

- **Zastępstwo** ustawia sam użytkownik w „Moje konto” (administrator także za innych). Działa w podanym czasie, obejmuje też zadania otwarte wcześniej, a decyzja zapisuje się z adnotacją „W zastępstwie”.
- **Przekazanie** przenosi jedno zadanie na inną osobę.
- **Przepisanie** to wyjście awaryjne administratora, gdy akceptujący odszedł lub jest niedostępny. Wymaga powodu.

## Czego program świadomie nie robi

- Nie wysyła e-maili o każdym zdarzeniu: poczta idzie tylko przy nowym zadaniu do decyzji, przy etapie „do wiadomości” i przy resecie hasła (gdy skonfigurowano SMTP). Pozostałe powiadomienia są w aplikacji.
- Nie obsługuje podpisu elektronicznego. Statusy `WAITING_FOR_SIGNATURE` i `SIGNED` pozostają nieużywane.
- Nie przelicza walut.
