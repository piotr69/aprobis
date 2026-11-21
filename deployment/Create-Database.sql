-- Aprobis: ręczne założenie bazy i konta aplikacji przez administratora SQL Server (DBA).
-- Zwykle nie jest potrzebne: Install-Aprobis.ps1 robi to samo bezpiecznie (parametry zamiast wklejania hasła).
--
-- Uruchomienie (flaga -I jest wymagana: indeksy filtrowane potrzebują QUOTED_IDENTIFIER ON):
--   sqlcmd -S <serwer> -E -I -i Create-Database.sql -v DbName="Aprobis" AppLogin="aprobis_app" AppPassword="<hasło>"
--
-- Uwaga: sqlcmd wkleja wartości zmiennych do tekstu skryptu, więc hasło NIE może zawierać apostrofu ani znaków
-- ; = { } (te ostatnie psują adres połączenia DATABASE_URL). Najprościej: długie hasło z liter i cyfr.
-- Potem w .env aplikacji:
--   DATABASE_URL="sqlserver://<serwer>:1433;database=Aprobis;user=aprobis_app;password=<hasło>;trustServerCertificate=true"
-- Migracje (npm run db:migrate:deploy) uruchamia się kontem z prawem zmiany schematu (np. kontem Windows DBA),
-- a nie kontem aplikacji, które dostaje tylko odczyt i zapis danych.

SET NOCOUNT ON;

IF DB_ID(N'$(DbName)') IS NULL
  EXEC (N'CREATE DATABASE ' + N'[$(DbName)]' + N' COLLATE Polish_100_CI_AS');
GO

IF SUSER_ID(N'$(AppLogin)') IS NULL
  CREATE LOGIN [$(AppLogin)] WITH PASSWORD = N'$(AppPassword)', CHECK_POLICY = ON, DEFAULT_DATABASE = [$(DbName)];
GO

USE [$(DbName)];
GO

IF USER_ID(N'$(AppLogin)') IS NULL
  CREATE USER [$(AppLogin)] FOR LOGIN [$(AppLogin)];
ALTER ROLE db_datareader ADD MEMBER [$(AppLogin)];
ALTER ROLE db_datawriter ADD MEMBER [$(AppLogin)];
GO
