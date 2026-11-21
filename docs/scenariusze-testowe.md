# Scenariusze

Scenariusze obiegu są zautomatyzowane w `backend/tests/integration` i działają na prawdziwej bazie `AprobisTest` wskazanej przez `TEST_DATABASE_URL` (`npm run test:integration`). Poniżej przegląd oczekiwanych ścieżek przy danych z seeda, także do ręcznego sprawdzenia.

| Dokument | Autor | Etapy |
| --- | --- | --- |
| Faktura do 5 000 PLN | Jan | Anna (przełożona) |
| Faktura 5 000 – 50 000 PLN | Jan | Anna, dyrektor |
| Faktura powyżej 50 000 PLN | Jan | Anna, księgowość, zarząd |
| Faktura w EUR lub USD | Jan | Anna, księgowość, zarząd |
| Umowa z kontrahentem | Jan | Dział prawny, Anna |
| Wniosek CAPEX | Anna | Piotr, księgowość, zarząd |
| Wniosek urlopowy (stały schemat) | Jan | Anna, kadry |
| Inny dokument kadrowy | Jan | Anna, kadry |
| Dokument bez pasującej reguły | Jan | Anna |

## Przejście ręczne

1. Zaloguj się jako `jan.pracownik`, utwórz wniosek urlopowy. Karta szkicu pokazuje, kto będzie akceptować. Złóż.
2. Jako `anna.kierownik` otwórz pozycję z „Do zrobienia przeze mnie” i zwróć do poprawy z uzasadnieniem.
3. Jako Jan: dzwonek pokazuje powiadomienie, dokument jest w „Do zrobienia” z powodem zwrotu. Złóż ponownie.
4. Jako Anna zatwierdź. W „Wykonane przeze mnie” wpis pokazuje, że obieg trwa dalej.
5. Jako `karolina.hr` zatwierdź, a potem przenieś do archiwum. Dokument trafia do „Zakończone” u wszystkich uczestników.

## Przypadki graniczne objęte testami

- Autor z roli akceptującej: decydują pozostali; gdy nie ma nikogo innego, etap idzie do przełożonego.
- Nieaktywny przełożony jest pomijany. Audytor lub administrator jako wyznaczony akceptujący: etap idzie wyżej.
- Równoczesne decyzje w jednym zadaniu: wygrywa jedna, druga dostaje konflikt.
- Etapy ALL, ANY, QUORUM i równoległe.
- Zastępstwo: obowiązuje w swoim czasie, obejmuje grupy, nie daje decyzji o dokumencie zastępowanego.
- Dokument zachowuje formularz wersji, na której powstał.
- Plik zablokowany przez antywirus uniemożliwia złożenie; limity liczby, formatu i rozmiaru załączników.
